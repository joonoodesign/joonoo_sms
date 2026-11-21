<?php
/**
 * 주누디자인 문자센터(joonoo_sms) 고정 IP 중계 게이트웨이
 * - 위치: 카페24 웹호스팅 /www/relay.php
 * - 역할: Google Apps Script의 요청을 HMAC 서명 검증 후 Solapi API로 전달하여
 *         카페24 고정 IP를 통해 KISA/Solapi IP 화이트리스트 제한 없이 발송 처리
 */

error_reporting(0);
header('Content-Type: application/json; charset=utf-8');

// 보안 비밀키: GAS의 RELAY_TOKEN과 반드시 일치해야 합니다.
$RELAY_SECRET = 'JOONOO_SMS_SECURE_RELAY_KEY_2026';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['relayOk' => false, 'relayError' => 'Method Not Allowed']);
    exit;
}

$rawInput = file_get_contents('php://input');
if (!$rawInput) {
    http_response_code(400);
    echo json_encode(['relayOk' => false, 'relayError' => 'Empty request body']);
    exit;
}

// 1. HMAC-SHA256 서명 검증
$reqSig = $_SERVER['HTTP_X_JOONOO_SIG'] ?? '';
$calcSig = hash_hmac('sha256', $rawInput, $RELAY_SECRET);

if (!hash_equals($calcSig, $reqSig)) {
    http_response_code(403);
    echo json_encode(['relayOk' => false, 'relayError' => 'Forbidden: Invalid HMAC signature']);
    exit;
}

$data = json_decode($rawInput, true);
if (!$data || !isset($data['path'])) {
    http_response_code(400);
    echo json_encode(['relayOk' => false, 'relayError' => 'Malformed JSON payload']);
    exit;
}

// 2. 타임스탬프 유효성 검사 (5분 이내 요청만 허용, 리플레이 공격 방지)
if (isset($data['ts'])) {
    $now = time();
    $reqTs = intval($data['ts']);
    if (abs($now - $reqTs) > 300) {
        http_response_code(400);
        echo json_encode(['relayOk' => false, 'relayError' => 'Request timestamp expired']);
        exit;
    }
}

// 3. Solapi API 대상 URL 구성
$path = $data['path'];
if (strpos($path, '/') !== 0) {
    $path = '/' . $path;
}
$targetUrl = 'https://api.solapi.com' . $path;

$method = strtoupper($data['method'] ?? 'POST');
$authHeader = $data['auth'] ?? '';

$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $targetUrl);
curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_TIMEOUT, 20);
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);

$headers = [
    'Content-Type: application/json; charset=utf-8',
    'User-Agent: Mozilla/5.0 JoonooSmsRelay/2.2'
];
if ($authHeader) {
    $headers[] = 'Authorization: ' . $authHeader;
}
curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);

if (isset($data['body']) && $data['body'] !== null) {
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data['body'], JSON_UNESCAPED_UNICODE));
}

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlErr = curl_error($ch);
curl_close($ch);

if ($response === false) {
    http_response_code(502);
    echo json_encode([
        'relayOk' => false,
        'relayError' => 'cURL failed: ' . $curlErr
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

$parsedSolapi = json_decode($response, true);
if ($parsedSolapi === null) {
    $parsedSolapi = ['raw' => $response];
}

http_response_code(200);
echo json_encode([
    'relayOk' => true,
    'httpCode' => $httpCode,
    'solapi' => $parsedSolapi
], JSON_UNESCAPED_UNICODE);
