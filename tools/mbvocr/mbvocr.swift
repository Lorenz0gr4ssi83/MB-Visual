// mbvocr - riconoscimento del testo per MB Visual su macOS (framework Vision di Apple, nessuna libreria esterna).
// Uso:  mbvocr <immagine> [lingua, es. it-IT]
// Uscita (stdout, UTF-8): la stessa di mbvisual/ocr.ps1 su Windows, cioe' un JSON
//   [[["parola", x, y, larghezza, altezza], ...], ...]   una lista per riga, coordinate in pixel con origine in alto a sinistra.
// Compilazione (tools/build_mac.py): swiftc -O tools/mbvocr/mbvocr.swift -o bin/mbvocr
import Foundation
import Vision
import ImageIO

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

let args = CommandLine.arguments
if args.count < 2 { fail("uso: mbvocr <immagine> [lingua]") }
let lang = args.count > 2 ? args[2] : "it-IT"
let url = URL(fileURLWithPath: args[1])
guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fail("immagine non leggibile: \(args[1])") }
let W = Double(image.width), H = Double(image.height)

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = [lang, "en-US"]

do {
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
} catch {
    fail("riconoscimento non riuscito: \(error.localizedDescription)")
}

// riquadro normalizzato di Vision (origine in basso a sinistra) -> pixel con origine in alto a sinistra
func px(_ r: CGRect) -> [Double] {
    let x = Double(r.minX) * W, w = Double(r.width) * W, h = Double(r.height) * H
    let y = (1 - Double(r.maxY)) * H
    return [x, y, w, h]
}

var lines: [[[Any]]] = []
for obs in request.results ?? [] {
    guard let cand = obs.topCandidates(1).first else { continue }
    let text = cand.string
    var words: [[Any]] = []
    // parole separate dagli spazi (punteggiatura compresa, come il motore di Windows)
    var i = text.startIndex
    while i < text.endIndex {
        while i < text.endIndex && text[i].isWhitespace { i = text.index(after: i) }
        let start = i
        while i < text.endIndex && !text[i].isWhitespace { i = text.index(after: i) }
        if start == i { break }
        // il riquadro della parola; se Vision non lo da' si usa quello della riga
        let box = (try? cand.boundingBox(for: start..<i))?.boundingBox ?? obs.boundingBox
        words.append([String(text[start..<i])] + px(box).map { $0 as Any })
    }
    if words.isEmpty && !text.trimmingCharacters(in: .whitespaces).isEmpty {
        words.append([text] + px(obs.boundingBox).map { $0 as Any })
    }
    if !words.isEmpty { lines.append(words) }
}

let data = try JSONSerialization.data(withJSONObject: lines, options: [])
FileHandle.standardOutput.write(data)
