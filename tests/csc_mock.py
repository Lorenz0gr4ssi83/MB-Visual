"""Servizio di firma remota CSC SIMULATO, solo per il collaudo (tests/test_firma.py).

Ascolta solo su 127.0.0.1 con una porta libera; implementa le chiamate usate da mbvisual/csc.py nelle versioni v1 e v2
(info, auth/login, credentials/list|info|sendOTP|authorize, signatures/signHash) con una chiave di prova in memoria.
"""
import base64
import json
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa, utils

HASH = {"2.16.840.1.101.3.4.2.1": hashes.SHA256(), "2.16.840.1.101.3.4.2.2": hashes.SHA384(), "2.16.840.1.101.3.4.2.3": hashes.SHA512()}


class MockCSC:
    def __init__(self, key, cert, user="mario", password="segreta", pin="12345678", otp="654321", scal=1):
        self.key, self.cert = key, cert
        self.user, self.password, self.pin, self.otp, self.scal = user, password, pin, otp, scal
        self.tokens, self.sads, self.otp_sent, self.log = set(), {}, 0, []
        mock = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                parts = self.path.strip("/").split("/")  # csc/v1/credentials/info
                ver, ep = parts[1], "/".join(parts[2:])
                mock.log.append((ver, ep, body))
                code, out = mock.handle(ver, ep, body, self.headers.get("Authorization", ""))
                data = json.dumps(out).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()

    def handle(self, ver, ep, b, auth):
        if ep == "info":
            return 200, {"specs": "2.0.0.0" if ver == "v2" else "1.0.4.0", "name": "Mock CSC", "authType": ["basic"], "methods": []}
        if ep == "auth/login":
            exp = "Basic " + base64.b64encode(f"{self.user}:{self.password}".encode()).decode()
            if auth != exp:
                return 401, {"error": "invalid_request", "error_description": "credenziali errate"}
            tok = secrets.token_hex(8)
            self.tokens.add(tok)
            return 200, {"access_token": tok, "expires_in": 3600}
        if not auth.startswith("Bearer ") or auth[7:] not in self.tokens:
            return 401, {"error": "invalid_token"}
        if ep == "credentials/list":
            return 200, {"credentialIDs": ["CRED-1"]}
        if ep == "credentials/info":
            der = base64.b64encode(self.cert.public_bytes(serialization.Encoding.DER)).decode()
            is_rsa = isinstance(self.key, rsa.RSAPrivateKey)
            algo = ["1.2.840.113549.1.1.1", "1.2.840.113549.1.1.11"] if is_rsa else ["1.2.840.10045.4.3.2"]
            out = {"key": {"status": "enabled", "algo": algo, "len": 2048 if is_rsa else 256},
                   "cert": {"status": "valid", "certificates": [der]}, "multisign": 1, "SCAL": str(self.scal), "authMode": "explicit"}
            if ver == "v2":
                out["auth"] = {"mode": "explicit", "objects": [{"type": "Password", "id": "PIN"}, {"type": "Password", "id": "OTP", "generator": "online"}]}
            else:
                out["PIN"] = {"presence": "true", "format": "N"}
                out["OTP"] = {"presence": "true", "type": "online"}
            return 200, out
        if ep == "credentials/sendOTP":
            self.otp_sent += 1
            return 200, {}
        if ep == "credentials/authorize":
            if ver == "v2":
                ad = {x["id"]: x["value"] for x in b.get("authData") or []}
                pin, otp, hs = ad.get("PIN"), ad.get("OTP"), b.get("hashes")
            else:
                pin, otp, hs = b.get("PIN"), b.get("OTP"), b.get("hash")
            if pin != self.pin or otp != self.otp:
                return 400, {"error": "invalid_request", "error_description": "PIN o OTP errati"}
            if self.scal == 2 and not hs:
                return 400, {"error": "invalid_request", "error_description": "hash mancanti (SCAL2)"}
            sad = secrets.token_hex(8)
            self.sads[sad] = set(hs or [])
            return 200, {"SAD": sad, "expiresIn": 300}
        if ep == "signatures/signHash":
            sad = b.get("SAD")
            hs = b.get("hashes") if ver == "v2" else b.get("hash")
            halg = b.get("hashAlgorithmOID") if ver == "v2" else b.get("hashAlgo")
            if sad not in self.sads or (self.scal == 2 and set(hs) != self.sads[sad]):
                return 400, {"error": "invalid_request", "error_description": "SAD non valido"}
            del self.sads[sad]
            h = HASH[halg]
            sigs = []
            for x in hs:
                d = base64.b64decode(x)
                if isinstance(self.key, rsa.RSAPrivateKey):
                    s = self.key.sign(d, padding.PKCS1v15(), utils.Prehashed(h))
                else:
                    s = self.key.sign(d, ec.ECDSA(utils.Prehashed(h)))
                sigs.append(base64.b64encode(s).decode())
            return 200, {"signatures": sigs}
        return 404, {"error": "not_found"}
