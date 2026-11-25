import NaturalLanguage
import PDFKit
import UIKit
import XCTest
@testable import DshIOS

/// The knowledge base's app side (Learning/KnowledgeAPI.swift): reply shapes, file reading,
/// PDF text extraction, the OpenAI-compatible provider's wire format, and an evaluation of
/// Apple's sentence embedding on this simulator. No engine runs here.
final class KnowledgeAPITests: XCTestCase {
    private func data(_ text: String) -> Data { Data(text.utf8) }

    func testDecodesDocumentsAndSearchHits() throws {
        let docs = #"{"ok":true,"result":[{"id":1,"title":"微积分","kind":"md","sourceName":"a.md","chars":900,"chunkCount":3,"language":"zh-Hans","embeddingStatus":"ok","createdAt":1,"updatedAt":2}]}"#
        let documents = try LearningAPI.decode([KnowledgeDocument].self, data: data(docs), status: 200)
        XCTAssertEqual(documents.first?.language, "zh-Hans")
        let hits = #"{"ok":true,"result":{"mode":"hybrid","results":[{"documentId":1,"documentTitle":"微积分","chunkId":7,"ordinal":1,"chunkCount":3,"start":10,"end":90,"heading":"导数","excerpt":"导数是…","label":"《微积分》第 2/3 段（导数）","score":0.03},{"documentId":1,"documentTitle":"微积分","chunkId":8,"ordinal":2,"chunkCount":3,"start":80,"end":120,"excerpt":"x","label":"《微积分》第 3/3 段","score":0.01}]}}"#
        let found = try LearningAPI.decode(KnowledgeSearchResult.self, data: data(hits), status: 200)
        XCTAssertEqual(found.mode, "hybrid")
        XCTAssertEqual(found.results.map(\.chunkId), [7, 8])
        XCTAssertEqual(found.results[0].heading, "导数")
        XCTAssertNil(found.results[1].heading)
    }

    func testScannedPDFRefusalKeepsItsKind() {
        let reply = #"{"error":{"kind":"unsupported","message":"this PDF has no text layer"}}"#
        XCTAssertThrowsError(try LearningAPI.decode(KnowledgeDocument.self, data: data(reply), status: 422)) { error in
            XCTAssertEqual((error as? LearningError)?.kind, "unsupported")
        }
    }

    func testFileKinds() {
        XCTAssertEqual(KnowledgeFiles.kind(of: "a.TXT"), "txt")
        XCTAssertEqual(KnowledgeFiles.kind(of: "notes.markdown"), "md")
        XCTAssertEqual(KnowledgeFiles.kind(of: "b.md"), "md")
        XCTAssertEqual(KnowledgeFiles.kind(of: "c.pdf"), "pdf")
        XCTAssertNil(KnowledgeFiles.kind(of: "d.docx"))
    }

    func testDecodesUTF8WithBOMUTF16AndGB18030() throws {
        XCTAssertEqual(KnowledgeFiles.decodeText(Data([0xEF, 0xBB, 0xBF]) + Data("你好".utf8)), "你好")
        XCTAssertEqual(KnowledgeFiles.decodeText("函数".data(using: .utf16)!), "函数")
        let gb = String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(CFStringEncodings.GB_18030_2000.rawValue)))
        let bytes = try XCTUnwrap("导数是变化率".data(using: gb))
        XCTAssertNil(String(data: bytes, encoding: .utf8), "the sample really is not UTF-8")
        XCTAssertEqual(KnowledgeFiles.decodeText(bytes), "导数是变化率")
    }

    private func makePDF(drawText: String?) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("kb-\(UUID().uuidString).pdf")
        let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 400, height: 400))
        try renderer.writePDF(to: url) { context in
            context.beginPage()
            if let drawText {
                (drawText as NSString).draw(at: CGPoint(x: 20, y: 20), withAttributes: [.font: UIFont.systemFont(ofSize: 14)])
            } else {
                UIColor.gray.setFill()
                UIRectFill(CGRect(x: 20, y: 20, width: 200, height: 100))
            }
        }
        return url
    }

    func testReadsAPDFTextLayerAndRefusesAScan() throws {
        let text = try makePDF(drawText: "Derivatives measure change")
        let read = try KnowledgeFiles.read(text)
        XCTAssertEqual(read.kind, "pdf")
        XCTAssertTrue(read.text.contains("Derivatives measure change"), read.text)
        let scan = try makePDF(drawText: nil)
        XCTAssertThrowsError(try KnowledgeFiles.read(scan)) { error in
            XCTAssertEqual(error as? KnowledgeImportError, .scannedPDF)
        }
    }

    func testRefusesOtherTypesAndOverlongFiles() throws {
        let docx = FileManager.default.temporaryDirectory.appendingPathComponent("x.docx")
        try Data("x".utf8).write(to: docx)
        XCTAssertThrowsError(try KnowledgeFiles.read(docx)) { error in
            XCTAssertEqual(error as? KnowledgeImportError, .unsupportedType("docx"))
        }
        let long = FileManager.default.temporaryDirectory.appendingPathComponent("long.txt")
        try Data(String(repeating: "长", count: KnowledgeFiles.maxCharacters + 1).utf8).write(to: long)
        XCTAssertThrowsError(try KnowledgeFiles.read(long)) { error in
            XCTAssertEqual(error as? KnowledgeImportError, .tooLong(KnowledgeFiles.maxCharacters + 1))
        }
    }

    func testProviderModelNameEndpointAndWireFormat() throws {
        let provider = EmbeddingProvider(baseURL: "https://api.example.com/v1", model: "text-embedding-3-small")
        XCTAssertEqual(provider.engineModel, "openai/api.example.com/text-embedding-3-small")
        XCTAssertEqual(provider.endpoint?.absoluteString, "https://api.example.com/v1/embeddings")
        XCTAssertNil(EmbeddingProvider(baseURL: "http://insecure.example.com", model: "m").endpoint, "only https")
        let body = try JSON.parse(EmbeddingProvider.requestBody(model: "m", texts: ["a", "b"]))
        XCTAssertEqual(body["model"].string, "m")
        XCTAssertEqual(body["input"].array.compactMap(\.string), ["a", "b"])
        // Out of order on purpose: `index` decides the position.
        let reply = #"{"data":[{"index":1,"embedding":[0.5,0.25]},{"index":0,"embedding":[1,0]}]}"#
        XCTAssertEqual(try EmbeddingProvider.parse(data(reply), count: 2), [[1, 0], [0.5, 0.25]])
        XCTAssertThrowsError(try EmbeddingProvider.parse(data(#"{"data":[{"index":0,"embedding":[1]}]}"#), count: 2))
        XCTAssertThrowsError(try EmbeddingProvider.parse(data(#"{"error":{"message":"bad key"}}"#), count: 1)) { error in
            XCTAssertEqual(error.localizedDescription, "bad key")
        }
    }

    /// Apple's sentence embedding, measured on the CI simulator (docs/PLAN.md §12 quotes these
    /// lines). Missing embeddings and a poor ranking are findings, not failures.
    func testEvaluateAppleSentenceEmbedding() {
        let cases: [(NLLanguage, String, String, String)] = [
            (.simplifiedChinese, "导数表示函数的变化率", "函数在一点的瞬时变化率就是导数", "今天下午去超市买苹果"),
            (.english, "The derivative measures how a function changes", "A derivative is the instantaneous rate of change", "I bought apples at the market"),
        ]
        for (language, query, related, unrelated) in cases {
            guard let embedding = NLEmbedding.sentenceEmbedding(for: language) else {
                print("NLEMBED language=\(language.rawValue) available=false")
                continue
            }
            let near = embedding.distance(between: query, and: related, distanceType: .cosine)
            let far = embedding.distance(between: query, and: unrelated, distanceType: .cosine)
            let vector = embedding.vector(for: query)
            print("NLEMBED language=\(language.rawValue) available=true dimension=\(embedding.dimension) revision=\(embedding.revision) vector=\(vector?.count ?? -1) near=\(near) far=\(far) order=\(near < far ? "ok" : "wrong")")
            XCTAssertEqual(vector?.count, embedding.dimension)
            // The order is recorded, not asserted: a poor ranking is a finding for DECISIONS, not a broken build.
        }
    }
}
