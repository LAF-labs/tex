// 폰 앱 네이티브 보조(iOS). D08 §3.1·D07: 보관 파일 백업 제외·파일 보호 등급, ADR-034 결정 9(제안): 기기 안 OCR(Vision).
// 사진·글자 내용을 로그에 남기지 않는다.
import ExpoModulesCore
import Foundation
import Vision
import UIKit

public class SaxNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SaxNative")

    // 파일·폴더에 백업 제외(NSURLIsExcludedFromBackupKey)와 NSFileProtectionComplete를 건다. 결과를 다시 읽어 돌려준다.
    AsyncFunction("protectPath") { (uri: String) -> [String: Any] in
      guard var url = URL(string: uri), url.isFileURL else { throw SaxError.badUri }
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try url.setResourceValues(values)
      try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
      return try inspect(url)
    }

    AsyncFunction("inspectPath") { (uri: String) -> [String: Any] in
      guard let url = URL(string: uri), url.isFileURL else { throw SaxError.badUri }
      return try inspect(url)
    }

    Function("ocrAvailable") { () -> Bool in
      if #available(iOS 16.0, *) {
        let req = VNRecognizeTextRequest()
        req.revision = VNRecognizeTextRequestRevision3
        let langs = (try? req.supportedRecognitionLanguages()) ?? []
        return langs.contains("ko-KR")
      }
      return false
    }

    // 기기 안 OCR. 네트워크·모델 호출 없음. 위에서 아래 순서의 줄 문자열만 돌려준다.
    AsyncFunction("recognizeText") { (uri: String) -> [String] in
      guard let url = URL(string: uri), url.isFileURL,
            let image = UIImage(contentsOfFile: url.path), let cg = image.cgImage else { throw SaxError.badUri }
      let req = VNRecognizeTextRequest()
      if #available(iOS 16.0, *) { req.revision = VNRecognizeTextRequestRevision3 }
      req.recognitionLevel = .accurate
      req.recognitionLanguages = ["ko-KR", "en-US"]
      req.usesLanguageCorrection = false
      let handler = VNImageRequestHandler(cgImage: cg, orientation: cgOrientation(image.imageOrientation), options: [:])
      try handler.perform([req])
      let obs = (req.results ?? []).sorted { a, b in
        // Vision 좌표는 아래가 0. 위 줄부터.
        if abs(a.boundingBox.midY - b.boundingBox.midY) > 0.01 { return a.boundingBox.midY > b.boundingBox.midY }
        return a.boundingBox.minX < b.boundingBox.minX
      }
      return obs.compactMap { $0.topCandidates(1).first?.string }
    }
  }
}

enum SaxError: Error {
  case badUri
}

private func inspect(_ url: URL) throws -> [String: Any] {
  let v = try url.resourceValues(forKeys: [.isExcludedFromBackupKey])
  let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
  let prot = (attrs[.protectionKey] as? FileProtectionType)?.rawValue ?? "none"
  return ["excludedFromBackup": v.isExcludedFromBackup ?? false, "protection": prot]
}

private func cgOrientation(_ o: UIImage.Orientation) -> CGImagePropertyOrientation {
  switch o {
  case .up: return .up
  case .down: return .down
  case .left: return .left
  case .right: return .right
  case .upMirrored: return .upMirrored
  case .downMirrored: return .downMirrored
  case .leftMirrored: return .leftMirrored
  case .rightMirrored: return .rightMirrored
  @unknown default: return .up
  }
}
