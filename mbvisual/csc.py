"""Firma remota con lo standard Cloud Signature Consortium (CSC API v1 e v2).

La chiave resta nell'HSM del certificatore: l'app manda solo l'impronta (hash) da firmare, con il PIN e l'OTP che
l'utente digita per quella firma (non vengono salvati). Indirizzo del servizio, utente e password API li fornisce il
certificatore. Solo libreria standard (urllib) + asn1crypto; il firmatario si aggancia a pyHanko (Signer).
"""
import base64
import hashlib
import json
import re
import urllib.error
import urllib.request

from asn1crypto import algos, x509

from .i18n import t

HASH_OID = {"sha256": "2.16.840.1.101.3.4.2.1", "sha384": "2.16.840.1.101.3.4.2.2", "sha512": "2.16.840.1.101.3.4.2.3"}
RSA_OID = "1.2.840.113549.1.1.1"
RSA_WITH = {"sha256": "1.2.840.113549.1.1.11", "sha384": "1.2.840.113549.1.1.12", "sha512": "1.2.840.113549.1.1.13"}
EC_WITH = {"sha256": "1.2.840.10045.4.3.2", "sha384": "1.2.840.10045.4.3.3", "sha512": "1.2.840.10045.4.3.4"}

_SESSIONS: dict[str, "Session"] = {}  # servizio + utente -> sessione aperta (token in memoria, mai su disco)


class CSCError(Exception):
    pass


def _split_url(url: str) -> tuple[str, str | None]:
    """'https://x/y/csc/v2/' -> ('https://x/y', 'v2'); senza /csc/vN la versione si scopre con info."""
    url = url.strip().rstrip("/")
    m = re.search(r"/csc/(v\d)(/info)?$", url, re.I)
    if m:
        return url[: m.start()], m.group(1).lower()
    return url, None


class Session:
    def __init__(self, url: str, token: str | None = None, timeout: int = 60):
        self.base, self.ver = _split_url(url)
        if not re.match(r"^https?://", self.base, re.I):
            raise CSCError(t("srv_firma.csc_url_non_valido"))
        self.token = token
        self.timeout = timeout
        self.info = None

    # -------------------------------------------------------------- chiamate
    def call(self, endpoint: str, body: dict | None = None, basic: tuple[str, str] | None = None) -> dict:
        url = f"{self.base}/csc/{self.ver or 'v1'}/{endpoint}"
        req = urllib.request.Request(url, data=json.dumps(body or {}).encode("utf-8"), method="POST",
                                     headers={"Content-Type": "application/json", "Accept": "application/json"})
        if basic:
            req.add_header("Authorization", "Basic " + base64.b64encode(f"{basic[0]}:{basic[1]}".encode("utf-8")).decode())
        elif self.token:
            req.add_header("Authorization", "Bearer " + self.token)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                data = r.read()
            return json.loads(data.decode("utf-8")) if data else {}
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read().decode("utf-8"))
                msg = err.get("error_description") or err.get("error") or str(e)
            except Exception:  # noqa: BLE001
                msg = str(e)
            if e.code in (401, 403) and endpoint not in ("credentials/authorize",):
                raise CSCError(t("srv_firma.csc_accesso_negato", msg)) from None
            raise CSCError(t("srv_firma.csc_errore_servizio", endpoint, msg)) from None
        except urllib.error.URLError as e:
            raise CSCError(t("srv_firma.csc_non_raggiungibile", self.base, getattr(e, "reason", e))) from None

    def discover(self) -> dict:
        """Chiama info; senza versione nell'indirizzo prova prima v2 poi v1."""
        tries = [self.ver] if self.ver else ["v2", "v1"]
        last = None
        for v in tries:
            self.ver = v
            try:
                self.info = self.call("info", {"lang": "it"})
                return self.info
            except CSCError as e:
                last = e
        raise last

    def login(self, user: str, password: str):
        r = self.call("auth/login", {"rememberMe": False}, basic=(user, password))
        tok = r.get("access_token")
        if not tok:
            raise CSCError(t("srv_firma.csc_login_fallito"))
        self.token = tok

    # -------------------------------------------------------------- credenziali
    def credentials(self) -> list[dict]:
        r = self.call("credentials/list", {"maxResults": 20})
        out = []
        for cid in r.get("credentialIDs") or []:
            try:
                out.append(self.credential_info(cid))
            except CSCError:
                continue
        return out

    def credential_info(self, cid: str) -> dict:
        r = self.call("credentials/info", {"credentialID": cid, "certificates": "chain", "certInfo": True, "authInfo": True})
        certs = [x509.Certificate.load(base64.b64decode(c)) for c in (r.get("cert") or {}).get("certificates") or []]
        if not certs:
            raise CSCError(t("srv_firma.csc_senza_certificato", cid))
        key = r.get("key") or {}
        # v1: PIN/OTP con "presence"; v2: auth.objects con id PIN/OTP
        pin = otp = False
        otp_online = False
        if isinstance(r.get("PIN"), dict):
            pin = str(r["PIN"].get("presence", "true")) != "false"
        if isinstance(r.get("OTP"), dict):
            otp = str(r["OTP"].get("presence", "true")) != "false"
            otp_online = r["OTP"].get("type") == "online"
        auth = r.get("auth") or {}
        for o in auth.get("objects") or []:
            if (o.get("id") or "").upper() == "PIN":
                pin = True
            if (o.get("id") or "").upper() == "OTP":
                otp = True
                otp_online = otp_online or o.get("generator") == "online" or o.get("type") == "online"
        mode = r.get("authMode") or auth.get("mode") or "explicit"
        return {"id": cid, "certs": certs, "algos": list(key.get("algo") or []), "pin": pin, "otp": otp, "otp_online": otp_online,
                "scal": int(str(r.get("SCAL", "1")) or 1), "modo": mode, "stato": key.get("status", "enabled")}

    def send_otp(self, cid: str):
        self.call("credentials/sendOTP", {"credentialID": cid})

    # -------------------------------------------------------------- firma
    def authorize(self, cid: str, hashes_b64: list[str], hash_name: str, pin: str | None, otp: str | None, scal: int) -> str:
        if self.ver == "v2":
            body = {"credentialID": cid, "numSignatures": len(hashes_b64)}
            if scal == 2:
                body.update(hashes=hashes_b64, hashAlgorithmOID=HASH_OID[hash_name])
            data = [{"id": k, "value": v} for k, v in (("PIN", pin), ("OTP", otp)) if v]
            if data:
                body["authData"] = data
        else:
            body = {"credentialID": cid, "numSignatures": len(hashes_b64)}
            if scal == 2:
                body["hash"] = hashes_b64
            if pin:
                body["PIN"] = pin
            if otp:
                body["OTP"] = otp
        try:
            r = self.call("credentials/authorize", body)
        except CSCError as e:
            raise CSCError(t("srv_firma.csc_autorizzazione_negata", e)) from None
        sad = r.get("SAD")
        if not sad:
            raise CSCError(t("srv_firma.csc_autorizzazione_negata", "SAD"))
        return sad

    def sign_hash(self, cid: str, sad: str, hashes_b64: list[str], hash_name: str, sign_oid: str) -> list[bytes]:
        if self.ver == "v2":
            body = {"credentialID": cid, "SAD": sad, "hashes": hashes_b64, "hashAlgorithmOID": HASH_OID[hash_name], "signAlgo": sign_oid}
        else:
            body = {"credentialID": cid, "SAD": sad, "hash": hashes_b64, "hashAlgo": HASH_OID[hash_name], "signAlgo": sign_oid}
        r = self.call("signatures/signHash", body)
        sigs = r.get("signatures") or []
        if len(sigs) != len(hashes_b64):
            raise CSCError(t("srv_firma.csc_risposta_non_valida"))
        return [base64.b64decode(s) for s in sigs]


def session(url: str, user: str = "", password: str = "", token: str = "") -> Session:
    s = Session(url, token or None)
    s.discover()
    if not token and user:
        s.login(user, password)
    if not s.token:
        raise CSCError(t("srv_firma.csc_serve_accesso"))
    _SESSIONS[_key(url, user)] = s
    return s


def _key(url, user):
    return _split_url(url)[0].lower() + "|" + (user or "").lower()


def cached(url: str, user: str = "") -> Session | None:
    return _SESSIONS.get(_key(url, user))


def make_signer(sess: Session, cid: str, pin: str | None, otp: str | None):
    """Firmatario pyHanko che firma l'impronta sul servizio remoto."""
    from pyhanko.sign.signers.pdf_cms import Signer
    from pyhanko_certvalidator.registry import SimpleCertificateStore

    info = sess.credential_info(cid)
    cert = info["certs"][0]
    key_algo = cert.public_key.algorithm
    supported = set(info["algos"])

    class CSCRemoteSigner(Signer):
        async def async_sign_raw(self, data: bytes, digest_algorithm: str, dry_run=False) -> bytes:
            if dry_run:
                return bytes(cert.public_key.bit_size // 8 if key_algo == "rsa" else 2 * ((cert.public_key.bit_size + 7) // 8) + 9)
            if digest_algorithm not in HASH_OID:
                raise CSCError(t("srv_firma.impronta_non_supportata", digest_algorithm))
            h = base64.b64encode(hashlib.new(digest_algorithm, data).digest()).decode()
            if key_algo == "rsa":
                oid = RSA_WITH[digest_algorithm] if RSA_WITH[digest_algorithm] in supported or RSA_OID not in supported else RSA_OID
            else:
                oid = EC_WITH[digest_algorithm]
            sad = sess.authorize(cid, [h], digest_algorithm, pin, otp, info["scal"])
            sig = sess.sign_hash(cid, sad, [h], digest_algorithm, oid)[0]
            if key_algo == "ec" and sig[:1] != b"\x30":
                sig = algos.DSASignature.from_p1363(sig).dump()
            return sig

    return CSCRemoteSigner(signing_cert=cert, cert_registry=SimpleCertificateStore.from_certs(info["certs"]), embed_roots=False)
