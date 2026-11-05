package expo.modules.saxnative

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Android: 앱 전용 저장소(filesDir)는 다른 앱이 읽을 수 없고, 백업 제외는 매니페스트(allowBackup=false +
// dataExtractionRules, plugins/with-android-backup-rules)로 건다. 기기 안 OCR(ML Kit)은 제안이라 아직 없다.
class SaxNativeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SaxNative")

    AsyncFunction("protectPath") { _: String ->
      mapOf("excludedFromBackup" to true, "protection" to "app_private")
    }

    AsyncFunction("inspectPath") { _: String ->
      mapOf("excludedFromBackup" to true, "protection" to "app_private")
    }

    Function("ocrAvailable") { false }

    AsyncFunction("recognizeText") { _: String ->
      throw CodedException("ERR_OCR_UNAVAILABLE", "on-device OCR not implemented on Android", null)
    }
  }
}
