// 측정 하네스 의존(패키지 경계 한곳). 트립와이어는 egress가 실제로 쓰는 함수다.
export { Redactor, koreanDigitCopy, normalizeForDetection } from '@sax/redaction';
export { piiTripwire as piiTripwireSafe } from '@sax/net';
