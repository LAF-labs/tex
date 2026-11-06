// SAX 레지스트리 서명 키 도우미(macOS, 단독 모드 ADR-037). 빌드: CEREMONY.md §3.
//   swiftc -O sax-keychain.swift -o sax-keychain && codesign -s - -f sax-keychain
// 규약(CEREMONY.md 부록 A, services/registry/src/ceremony/wrap.ts와 같은 바이트):
//   Ed25519 시드는 Secure Enclave P-256 키 W(접근 제어 privateKeyUsage + biometryCurrentSet)로 감싸
//   로그인 키체인(서비스 com.laf.sax.registry-ceremony)에 감싼 블롭만 둔다. 디스크·키체인에 시드 평문은 없다.
//   서명은 이 프로세스 안에서 한다: Touch ID → W로 풀기 → CryptoKit Ed25519 서명 → 시드 버퍼 0으로 덮기. 시드는 stdout으로 나가지 않는다
//   (예외: export — 백업 파일을 만들 때만, 부르는 Node가 암호로 잠근다).
// 출력은 한 줄 JSON. 오류는 {"error":"<code>"}와 종료 코드 1.
import CryptoKit
import Foundation
import LocalAuthentication
import Security

let SERVICE = "com.laf.sax.registry-ceremony"
let WRAP_ACCOUNT = "wrap-key"
let WRAP_ALG = "SAX-ceremony-wrap-v1"
let KEY_ID = try! NSRegularExpression(pattern: "^(root|package|policy|emergency|timestamp|release)-[0-9]+$")

struct Fail: Error { let code: String }

func out(_ s: String) { FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!) }
func fail(_ code: String) -> Never {
  out("{\"error\":\"\(code)\"}")
  exit(1)
}
func validKeyId(_ k: String) -> Bool { KEY_ID.firstMatch(in: k, range: NSRange(k.startIndex..., in: k)) != nil }
func b64(_ d: Data) -> String { d.base64EncodedString() }
func wipe(_ d: inout Data) { d.withUnsafeMutableBytes { p in if let b = p.baseAddress { memset_s(b, p.count, 0, p.count) } } }
func readStdin() -> String { String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8)!.trimmingCharacters(in: .whitespacesAndNewlines) }

// ---- 키체인(감싼 블롭만) ----
func kcGet(_ account: String) -> Data? {
  let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: SERVICE, kSecAttrAccount as String: account, kSecReturnData as String: true]
  var o: CFTypeRef?
  return SecItemCopyMatching(q as CFDictionary, &o) == errSecSuccess ? o as? Data : nil
}
func kcAdd(_ account: String, _ data: Data) throws {
  let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: SERVICE, kSecAttrAccount as String: account, kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
  let st = SecItemAdd(q as CFDictionary, nil)
  if st == errSecDuplicateItem { throw Fail(code: "ceremony.key_exists") }
  if st != errSecSuccess { throw Fail(code: "ceremony.keychain_failed") }
}
func kcDelete(_ account: String) -> Bool {
  let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: SERVICE, kSecAttrAccount as String: account]
  return SecItemDelete(q as CFDictionary) == errSecSuccess
}
func kcAccounts() -> [String] {
  let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: SERVICE, kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitAll]
  var o: CFTypeRef?
  guard SecItemCopyMatching(q as CFDictionary, &o) == errSecSuccess, let items = o as? [[String: Any]] else { return [] }
  return items.compactMap { $0[kSecAttrAccount as String] as? String }.sorted()
}

// ---- 감싸기 규약 ----
func wrapInfo(_ epk: Data, _ wpub: Data, _ keyId: String) -> Data { Data(WRAP_ALG.utf8) + epk + wpub + Data(keyId.utf8) }
func aad(_ keyId: String) -> Data { Data(WRAP_ALG.utf8) + Data(keyId.utf8) }
func ed25519Pub(_ seed: Data) throws -> Data { try Curve25519.Signing.PrivateKey(rawRepresentation: seed).publicKey.rawRepresentation }

/** JCS: 키 이름 순(alg, ct, epk, keyId, nonce, pub, v). 값은 base64·keyId(이스케이프할 문자 없음)·정수. */
func blobJcs(keyId: String, pub: Data, epk: Data, nonce: Data, ct: Data) -> String {
  "{\"alg\":\"\(WRAP_ALG)\",\"ct\":\"\(b64(ct))\",\"epk\":\"\(b64(epk))\",\"keyId\":\"\(keyId)\",\"nonce\":\"\(b64(nonce))\",\"pub\":\"\(b64(pub))\",\"v\":1}"
}

func wrap(keyId: String, seed: Data, wrapPub: P256.KeyAgreement.PublicKey, ephemeral: P256.KeyAgreement.PrivateKey = P256.KeyAgreement.PrivateKey(), nonce: Data? = nil) throws -> String {
  let epk = ephemeral.publicKey.x963Representation
  let wpub = wrapPub.x963Representation
  let z = try ephemeral.sharedSecretFromKeyAgreement(with: wrapPub)
  let kek = z.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(), sharedInfo: wrapInfo(epk, wpub, keyId), outputByteCount: 32)
  let n = try ChaChaPoly.Nonce(data: nonce ?? Data((0..<12).map { _ in UInt8.random(in: 0...255) }))
  let box = try ChaChaPoly.seal(seed, using: kek, nonce: n, authenticating: aad(keyId))
  return blobJcs(keyId: keyId, pub: try ed25519Pub(seed), epk: epk, nonce: Data(n), ct: box.ciphertext + box.tag)
}

struct Blob: Decodable { let v: Int; let alg: String; let keyId: String; let pub: String; let epk: String; let nonce: String; let ct: String }

/** W(Secure Enclave)로 푼다. 이때 Touch ID가 뜬다(ctx.localizedReason). 돌려준 시드는 부르는 쪽이 wipe한다. */
func unwrap(_ blobData: Data, keyId: String, ctx: LAContext) throws -> Data {
  guard let b = try? JSONDecoder().decode(Blob.self, from: blobData), b.v == 1, b.alg == WRAP_ALG, b.keyId == keyId,
        let epk = Data(base64Encoded: b.epk), let nonce = Data(base64Encoded: b.nonce), let ct = Data(base64Encoded: b.ct), let pub = Data(base64Encoded: b.pub),
        ct.count == 48 else { throw Fail(code: "ceremony.blob_invalid") }
  guard let wblob = kcGet(WRAP_ACCOUNT) else { throw Fail(code: "ceremony.no_wrap_key") }
  let w = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: wblob, authenticationContext: ctx)
  let z: SharedSecret
  do { z = try w.sharedSecretFromKeyAgreement(with: try P256.KeyAgreement.PublicKey(x963Representation: epk)) } catch { throw Fail(code: "ceremony.auth_failed") }
  let kek = z.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(), sharedInfo: wrapInfo(epk, w.publicKey.x963Representation, keyId), outputByteCount: 32)
  let box = try ChaChaPoly.SealedBox(nonce: try ChaChaPoly.Nonce(data: nonce), ciphertext: ct.prefix(32), tag: ct.suffix(16))
  var seed: Data
  do { seed = try ChaChaPoly.open(box, using: kek, authenticating: aad(keyId)) } catch { throw Fail(code: "ceremony.unwrap_failed") }
  guard (try? ed25519Pub(seed)) == pub else { wipe(&seed); throw Fail(code: "ceremony.unwrap_failed") }
  return seed
}

func wrapKey() throws -> SecureEnclave.P256.KeyAgreement.PrivateKey {
  guard let wblob = kcGet(WRAP_ACCOUNT) else { throw Fail(code: "ceremony.no_wrap_key") }
  return try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: wblob)
}
func context(_ reason: String) -> LAContext {
  let c = LAContext()
  c.localizedReason = reason
  return c
}

// ---- 명령 ----
let args = Array(CommandLine.arguments.dropFirst())
do {
  switch args.first {
  case "init":
    // W 만들기(이미 있으면 그대로). 만드는 데는 Touch ID가 필요 없다(쓸 때마다 필요).
    if kcGet(WRAP_ACCOUNT) == nil {
      var e: Unmanaged<CFError>?
      guard SecureEnclave.isAvailable, let ac = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet], &e) else { fail("ceremony.secure_enclave_unavailable") }
      let w = try SecureEnclave.P256.KeyAgreement.PrivateKey(compactRepresentable: false, accessControl: ac)
      try kcAdd(WRAP_ACCOUNT, w.dataRepresentation)
    }
    out("{\"wrapPub\":\"\(b64(try wrapKey().publicKey.x963Representation))\"}")
  case "wrap-pub":
    out("{\"wrapPub\":\"\(b64(try wrapKey().publicKey.x963Representation))\"}")
  case "generate":
    guard args.count == 2, validKeyId(args[1]) else { fail("ceremony.usage") }
    if kcGet("key/\(args[1])") != nil { fail("ceremony.key_exists") }
    var seed = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
    defer { wipe(&seed) }
    let blob = try wrap(keyId: args[1], seed: seed, wrapPub: try wrapKey().publicKey)
    try kcAdd("key/\(args[1])", Data(blob.utf8))
    out("{\"keyId\":\"\(args[1])\",\"pub\":\"\(b64(try ed25519Pub(seed)))\"}")
  case "pubkey":
    guard args.count == 2, validKeyId(args[1]), let d = kcGet("key/\(args[1])"), let b = try? JSONDecoder().decode(Blob.self, from: d) else { fail("ceremony.key_missing") }
    out("{\"keyId\":\"\(b.keyId)\",\"pub\":\"\(b.pub)\"}")
  case "list":
    let ids = kcAccounts().filter { $0.hasPrefix("key/") }.map { "\"\($0.dropFirst(4))\"" }
    out("{\"keys\":[\(ids.joined(separator: ","))],\"wrapKey\":\(kcGet(WRAP_ACCOUNT) != nil)}")
  case "sign":
    // stdin: 서명 입력 바이트의 base64 한 줄. 화면 이유 문자열에 keyId와 확인 코드(부르는 쪽이 넘김)를 보인다.
    guard args.count >= 2, validKeyId(args[1]), let d = kcGet("key/\(args[1])") else { fail("ceremony.key_missing") }
    guard let msg = Data(base64Encoded: readStdin()), !msg.isEmpty, msg.count <= 512 * 1024 else { fail("ceremony.message_size") }
    let reason = "SAX 레지스트리 서명 \(args[1])" + (args.count >= 3 ? " (\(args[2]))" : "")
    var seed = try unwrap(d, keyId: args[1], ctx: context(reason))
    defer { wipe(&seed) }
    let k = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
    let sig = try k.signature(for: msg)
    guard k.publicKey.isValidSignature(sig, for: msg) else { fail("ceremony.signature_invalid") }
    out("{\"keyId\":\"\(args[1])\",\"sig\":\"\(b64(sig))\"}")
  case "export":
    // 백업 전용: Touch ID 한 번으로 고른 키를 풀어 시드를 내보낸다(부르는 Node가 바로 암호로 잠근다).
    let ids = Array(args.dropFirst())
    guard !ids.isEmpty, ids.allSatisfy(validKeyId) else { fail("ceremony.usage") }
    let ctx = context("SAX 레지스트리 키 백업 \(ids.count)개")
    var parts: [String] = []
    for id in ids {
      guard let d = kcGet("key/\(id)") else { fail("ceremony.key_missing") }
      var seed = try unwrap(d, keyId: id, ctx: ctx)
      parts.append("{\"keyId\":\"\(id)\",\"pub\":\"\(b64(try ed25519Pub(seed)))\",\"seed\":\"\(b64(seed))\"}")
      wipe(&seed)
    }
    out("{\"keys\":[\(parts.joined(separator: ","))]}")
  case "import":
    // stdin: 시드 base64. W 공개키로만 감싼다(Touch ID 없음). 같은 keyId가 있으면 덮지 않는다.
    guard args.count == 2, validKeyId(args[1]) else { fail("ceremony.usage") }
    if kcGet("key/\(args[1])") != nil { fail("ceremony.key_exists") }
    guard var seed = Data(base64Encoded: readStdin()), seed.count == 32 else { fail("ceremony.usage") }
    defer { wipe(&seed) }
    try kcAdd("key/\(args[1])", Data(try wrap(keyId: args[1], seed: seed, wrapPub: try wrapKey().publicKey).utf8))
    out("{\"keyId\":\"\(args[1])\",\"pub\":\"\(b64(try ed25519Pub(seed)))\"}")
  case "delete":
    // 지우기 전에 Touch ID로 본인 확인(되돌릴 수 없다: 백업이 없으면 키를 잃는다).
    guard args.count == 2, validKeyId(args[1]) else { fail("ceremony.usage") }
    var ok = false
    let sem = DispatchSemaphore(value: 0)
    context("SAX 레지스트리 키 삭제 \(args[1])").evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "SAX 레지스트리 키 삭제 \(args[1])") { r, _ in ok = r; sem.signal() }
    sem.wait()
    guard ok else { fail("ceremony.auth_failed") }
    out("{\"deleted\":\(kcDelete("key/\(args[1])"))}")
  case "selftest":
    // 키체인에 남기지 않는 시험: 새 시드를 W로 감싸고, Touch ID로 풀어, 서명·검증한다.
    var seed = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
    defer { wipe(&seed) }
    let blob = try wrap(keyId: "root-0", seed: seed, wrapPub: try wrapKey().publicKey)
    var back = try unwrap(Data(blob.utf8), keyId: "root-0", ctx: context("SAX 서명 도우미 자체 시험"))
    defer { wipe(&back) }
    let k = try Curve25519.Signing.PrivateKey(rawRepresentation: back)
    let msg = Data("SAX-ceremony-selftest".utf8)
    let sig = try k.signature(for: msg)
    let ok = back == seed && k.publicKey.isValidSignature(sig, for: msg)
    out("{\"ok\":\(ok)}")
  case "vector":
    // 시험 벡터(부록 A): Secure Enclave 대신 고정 소프트웨어 W(0x11×32), 임시 키 0x22×32, nonce 0x33×12, 시드 0x07×32, keyId root-1.
    let w = try P256.KeyAgreement.PrivateKey(rawRepresentation: Data(repeating: 0x11, count: 32))
    let e = try P256.KeyAgreement.PrivateKey(rawRepresentation: Data(repeating: 0x22, count: 32))
    out(try wrap(keyId: "root-1", seed: Data(repeating: 0x07, count: 32), wrapPub: w.publicKey, ephemeral: e, nonce: Data(repeating: 0x33, count: 12)))
  default:
    fail("ceremony.usage")
  }
} catch let f as Fail {
  fail(f.code)
} catch {
  fail("ceremony.helper_failed")
}
