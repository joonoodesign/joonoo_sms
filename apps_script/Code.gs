/**
 * ============================================================================
 * 주누디자인 고객 문자·알림톡 센터 (joonoo_sms) — Google Apps Script 클라우드 백엔드
 * ============================================================================
 * - 역할:
 *   1) 전 직원 실시간 발송내역 공유 대장 ('발송내역' 시트 자동 생성)
 *   2) 전 직원 공용 상용구/알림톡 템플릿 CRUD ('공용상용구' 시트 + 기본 7종 자동 시드)
 *   3) 사내 PIN 비밀번호 보안 인증 (상수 시간 비교 safeEqual_ 적용)
 *   4) Solapi REST API v4 연동 (HMAC-SHA256 서명 · SMS/LMS/카카오 알림톡 발송 · 잔액 조회)
 *   5) API Key / API Secret 브라우저 노출 0% (ScriptProperties 서버 금고 전용 보관)
 *   6) LockService + CacheService 기반 10초 이내 동일 번호·내용 더블클릭 중복 발송 원천 차단
 * ============================================================================
 */

var SHEET_HISTORY_ = "발송내역";
var SHEET_TEMPLATES_ = "공용상용구";
var DEFAULT_SENDER_DIGITS_ = "0532673973";

var HISTORY_HEADERS_ = [
  "id",
  "sent_at",
  "staff",
  "customer_name",
  "phone",
  "mode",
  "template_title",
  "message_preview",
  "tracking_info",
  "status",
  "group_id"
];

var TEMPLATE_HEADERS_ = [
  "id",
  "category",
  "title",
  "mode",
  "subject",
  "body",
  "template_id",
  "buttons_info",
  "updated_by",
  "updated_at"
];

/**
 * 주누디자인 기본 공용 상용구 7종 (시트가 비어있을 때 최초 1회 자동 시드)
 */
var DEFAULT_TEMPLATES_ = [
  {
    id: "tpl_kakao_chat",
    category: "상담·안내",
    title: "🟡 카카오톡 1:1 상담창 안내",
    mode: "SMS",
    subject: "[주누디자인] 카톡 상담창 안내",
    body:
      "안녕하세요, #{고객명}님! 인쇄·디자인 전문 주누디자인입니다.\n" +
      "문의 주셔서 감사합니다. 인쇄 원고·로고·사진 전달 및 시안 상담은 아래 공식 카카오톡 상담창으로 말씀 남겨주시면 순차적으로 안내해 드리겠습니다.\n\n" +
      "▶ 카톡 1:1 상담창 바로가기\n" +
      "https://pf.kakao.com/_xhlXFj/chat\n\n" +
      "▶ 공식 쇼핑몰: https://joonoo.co.kr\n" +
      "☎ 고객센터: 053-267-3973",
    template_id: "",
    buttons_info: JSON.stringify([
      {
        name: "카카오톡 상담창 열기",
        type: "WL",
        url_mobile: "https://pf.kakao.com/_xhlXFj/chat",
        url_pc: "https://pf.kakao.com/_xhlXFj/chat"
      },
      {
        name: "채널 추가",
        type: "AC"
      }
    ])
  },
  {
    id: "tpl_shipping_track",
    category: "배송·출고",
    title: "📦 택배 출고 및 송장 배송조회 안내",
    mode: "SMS",
    subject: "[주누디자인] 인쇄물 출고 안내",
    body:
      "안녕하세요, #{고객명}님! 주누디자인입니다.\n" +
      "주문하신 인쇄물이 제작 완료되어 오늘 출고되었습니다.\n\n" +
      "■ 택배사: #{택배사}\n" +
      "■ 송장번호: #{송장번호}\n\n" +
      "▶ 실시간 배송조회 바로가기\n" +
      "https://#{배송조회주소}\n\n" +
      "받으실 때까지 안전하게 배송하겠습니다. 감사합니다.\n" +
      "☎ 문의: 053-267-3973",
    template_id: "",
    buttons_info: JSON.stringify([
      {
        name: "실시간 배송조회",
        type: "WL",
        url_mobile: "https://#{배송조회주소}",
        url_pc: "https://#{배송조회주소}"
      },
      {
        name: "카카오톡 문의하기",
        type: "WL",
        url_mobile: "https://pf.kakao.com/_xhlXFj/chat",
        url_pc: "https://pf.kakao.com/_xhlXFj/chat"
      }
    ])
  },
  {
    id: "tpl_proof_check",
    category: "시안·교정",
    title: "🎨 인쇄 시안 확인 요청 안내",
    mode: "SMS",
    subject: "[주누디자인] 인쇄 시안 확인 요청",
    body:
      "안녕하세요, #{고객명}님! 주누디자인입니다.\n" +
      "요청하신 디자인 시안 작업이 완료되어 안내드립니다.\n\n" +
      "오탈자·연락처·수량 등을 확인해 주신 뒤, 아래 카카오톡 상담창으로 [인쇄 진행 확정] 또는 [수정 요청사항]을 회신해 주세요.\n" +
      "(※ 확정 회신 후 인쇄가 진행되며, 인쇄 시작 후에는 수정이 어렵습니다.)\n\n" +
      "▶ 시안 확인 및 카톡 회신하기\n" +
      "https://pf.kakao.com/_xhlXFj/chat\n" +
      "☎ 고객센터: 053-267-3973",
    template_id: "",
    buttons_info: JSON.stringify([
      {
        name: "시안 확인 및 카톡 회신",
        type: "WL",
        url_mobile: "https://pf.kakao.com/_xhlXFj/chat",
        url_pc: "https://pf.kakao.com/_xhlXFj/chat"
      }
    ])
  },
  {
    id: "tpl_bank_account",
    category: "결제·입금",
    title: "💳 입금계좌 및 세금계산서 안내",
    mode: "SMS",
    subject: "[주누디자인] 입금계좌 안내",
    body:
      "안녕하세요, #{고객명}님! 주누디자인입니다.\n" +
      "요청하신 입금계좌 안내드립니다.\n\n" +
      "■ 입금은행: 농협 351-1052-3914-03\n" +
      "■ 예금주: 전현수 (주누디자인)\n\n" +
      "입금 후 카카오톡 상담창으로 입금자명(세금계산서 발행 시 사업자등록증 사본)을 보내주시면 빠르게 확인 도와드리겠습니다.\n" +
      "▶ 카톡 상담창: https://pf.kakao.com/_xhlXFj/chat",
    template_id: "",
    buttons_info: JSON.stringify([
      {
        name: "사업자등록증 카톡 전송",
        type: "WL",
        url_mobile: "https://pf.kakao.com/_xhlXFj/chat",
        url_pc: "https://pf.kakao.com/_xhlXFj/chat"
      }
    ])
  },
  {
    id: "tpl_visit_pickup",
    category: "방문·수령",
    title: "🏢 방문수령 및 사업장 주소 안내",
    mode: "SMS",
    subject: "[주누디자인] 방문수령 안내",
    body:
      "안녕하세요, #{고객명}님! 주누디자인입니다.\n" +
      "주문하신 인쇄물 제작이 완료되어 방문수령 가능합니다.\n\n" +
      "■ 사업장 주소: 대구광역시 달서구 구마로39길 38\n" +
      "■ 대표번호: 053-267-3973\n\n" +
      "방문 전 미리 연락 주시면 바로 수령하실 수 있도록 준비해 두겠습니다. 감사합니다!",
    template_id: "",
    buttons_info: "[]"
  },
  {
    id: "tpl_file_upload",
    category: "상담·안내",
    title: "📎 로고·인쇄 원본파일 접수 안내",
    mode: "SMS",
    subject: "[주누디자인] 원본파일 접수 안내",
    body:
      "안녕하세요, #{고객명}님! 주누디자인입니다.\n" +
      "보유하신 로고(AI 일러스트 원본)나 고화질 사진, 인쇄 원고를 아래 카카오톡 상담창으로 보내주시면 담당 디자이너가 확인 후 바로 안내드리겠습니다.\n\n" +
      "▶ 카톡으로 파일 보내기\n" +
      "https://pf.kakao.com/_xhlXFj/chat\n" +
      "▶ 공식몰: https://joonoo.co.kr\n" +
      "☎ 053-267-3973",
    template_id: "",
    buttons_info: JSON.stringify([
      {
        name: "카톡으로 파일 보내기",
        type: "WL",
        url_mobile: "https://pf.kakao.com/_xhlXFj/chat",
        url_pc: "https://pf.kakao.com/_xhlXFj/chat"
      }
    ])
  },
  {
    id: "tpl_short_sms",
    category: "상담·안내",
    title: "⚡ 통화중·부재중 초간단 단문(SMS 90B 이하)",
    mode: "SMS",
    subject: "",
    body: "[주누디자인] 통화중이었습니다. 카톡상담: https://pf.kakao.com/_xhlXFj/chat",
    template_id: "",
    buttons_info: "[]"
  }
];

function jsonOut_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 상수 시간 문자열 비교 (Timing Attack 방지)
 */
function safeEqual_(a, b) {
  var sa = String(a || "");
  var sb = String(b || "");
  if (sa.length !== sb.length) return false;
  var diff = 0;
  for (var i = 0; i < sa.length; i++) {
    diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  }
  return diff === 0;
}

function nowKst_() {
  return Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd HH:mm:ss");
}

function cleanDigits_(val) {
  return String(val || "").replace(/[^0-9]/g, "");
}

function formatKoreanPhone_(raw) {
  var d = cleanDigits_(raw);
  if (d.indexOf("02") === 0) {
    if (d.length === 9) return d.replace(/(\d{2})(\d{3})(\d{4})/, "$1-$2-$3");
    if (d.length === 10) return d.replace(/(\d{2})(\d{4})(\d{4})/, "$1-$2-$3");
  }
  if (d.length === 8) return d.replace(/(\d{4})(\d{4})/, "$1-$2");
  if (d.length === 10) return d.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3");
  if (d.length === 11) return d.replace(/(\d{3})(\d{4})(\d{4})/, "$1-$2-$3");
  return d || String(raw || "");
}

/**
 * 수식 주입(Formula Injection) 방지 및 문자열 정규화
 */
function safeCell_(val) {
  var s = String(val == null ? "" : val);
  if (/^[=+\-@]/.test(s)) {
    return "'" + s;
  }
  return s;
}

/**
 * 시트 2개('발송내역', '공용상용구') 자동 생성 및 기본 상용구 7종 시드
 */
function ensureSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1) 발송내역 시트
  var historySheet = ss.getSheetByName(SHEET_HISTORY_);
  if (!historySheet) {
    historySheet = ss.insertSheet(SHEET_HISTORY_);
    historySheet.getRange(1, 1, 1, HISTORY_HEADERS_.length).setValues([HISTORY_HEADERS_]);
    historySheet.setFrozenRows(1);
    historySheet.getRange(1, 1, 1, HISTORY_HEADERS_.length)
      .setBackground("#0B192C")
      .setFontColor("#FFFFFF")
      .setFontWeight("bold");
    historySheet.getRange("A:K").setNumberFormat("@");
  } else if (historySheet.getLastRow() === 0) {
    historySheet.getRange(1, 1, 1, HISTORY_HEADERS_.length).setValues([HISTORY_HEADERS_]);
    historySheet.setFrozenRows(1);
    historySheet.getRange("A:K").setNumberFormat("@");
  }

  // 2) 공용상용구 시트
  var tplSheet = ss.getSheetByName(SHEET_TEMPLATES_);
  if (!tplSheet) {
    tplSheet = ss.insertSheet(SHEET_TEMPLATES_);
    tplSheet.getRange(1, 1, 1, TEMPLATE_HEADERS_.length).setValues([TEMPLATE_HEADERS_]);
    tplSheet.setFrozenRows(1);
    tplSheet.getRange(1, 1, 1, TEMPLATE_HEADERS_.length)
      .setBackground("#0B192C")
      .setFontColor("#FFFFFF")
      .setFontWeight("bold");
    tplSheet.getRange("A:J").setNumberFormat("@");
  } else if (tplSheet.getLastRow() === 0) {
    tplSheet.getRange(1, 1, 1, TEMPLATE_HEADERS_.length).setValues([TEMPLATE_HEADERS_]);
    tplSheet.setFrozenRows(1);
    tplSheet.getRange("A:J").setNumberFormat("@");
  }

  // 기본 상용구 7종 시드 (데이터 행이 없을 때 자동 투입)
  if (tplSheet.getLastRow() <= 1) {
    var seedTime = nowKst_();
    var seedRows = DEFAULT_TEMPLATES_.map(function(t) {
      return [
        t.id,
        t.category,
        t.title,
        t.mode,
        t.subject,
        t.body,
        t.template_id,
        t.buttons_info,
        "시스템초기화",
        seedTime
      ];
    });
    tplSheet.getRange(2, 1, seedRows.length, TEMPLATE_HEADERS_.length)
      .setNumberFormat("@")
      .setValues(seedRows);
  }

  return {
    historySheet: historySheet,
    tplSheet: tplSheet
  };
}

/**
 * 민감정보(API Key/Secret) 원문을 절대 노출하지 않는 마스킹 설정 객체 생성
 */
function getMaskedConfig_(props) {
  var expectedPin = String(props.getProperty("APP_PIN") || "").trim();
  var apiKey = String(props.getProperty("SOLAPI_API_KEY") || "").trim();
  var apiSecret = String(props.getProperty("SOLAPI_API_SECRET") || "").trim();
  var senderDigits = cleanDigits_(props.getProperty("SENDER_PHONE") || DEFAULT_SENDER_DIGITS_) || DEFAULT_SENDER_DIGITS_;
  var pfId = String(props.getProperty("SOLAPI_PF_ID") || "").trim();

  var maskedKey = "";
  if (apiKey) {
    if (apiKey.length > 6) {
      maskedKey = apiKey.slice(0, 4) + "****" + apiKey.slice(-2);
    } else {
      maskedKey = apiKey.slice(0, 2) + "****";
    }
  }

  return {
    pinConfigured: Boolean(expectedPin),
    hasSolapiKey: Boolean(apiKey && apiSecret),
    maskedApiKey: maskedKey,
    senderPhone: formatKoreanPhone_(senderDigits),
    senderPhoneDigits: senderDigits,
    pfId: pfId
  };
}

function readTemplates_(tplSheet) {
  var lastRow = tplSheet.getLastRow();
  if (lastRow <= 1) return [];
  var values = tplSheet.getRange(2, 1, lastRow - 1, TEMPLATE_HEADERS_.length).getValues();
  var list = [];
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    if (!r[0] && !r[2] && !r[5]) continue;
    list.push({
      id: String(r[0] || ""),
      category: String(r[1] || "상담·안내"),
      title: String(r[2] || ""),
      mode: String(r[3] || "SMS"),
      subject: String(r[4] || ""),
      body: String(r[5] || ""),
      template_id: String(r[6] || ""),
      buttons_info: String(r[7] || "[]"),
      updated_by: String(r[8] || ""),
      updated_at: String(r[9] || "")
    });
  }
  return list;
}

function readHistory_(historySheet, maxCount) {
  var limit = maxCount || 300;
  var lastRow = historySheet.getLastRow();
  if (lastRow <= 1) return [];
  var startRow = Math.max(2, lastRow - limit + 1);
  var numRows = lastRow - startRow + 1;
  var values = historySheet.getRange(startRow, 1, numRows, HISTORY_HEADERS_.length).getValues();
  var list = [];
  for (var i = values.length - 1; i >= 0; i--) {
    var r = values[i];
    if (!r[0] && !r[4]) continue;
    list.push({
      id: String(r[0] || ""),
      sent_at: String(r[1] || ""),
      staff: String(r[2] || ""),
      customer_name: String(r[3] || ""),
      phone: formatKoreanPhone_(r[4]),
      mode: String(r[5] || "SMS"),
      template_title: String(r[6] || ""),
      message_preview: String(r[7] || ""),
      tracking_info: String(r[8] || ""),
      status: String(r[9] || ""),
      group_id: String(r[10] || "")
    });
  }
  return list;
}

/**
 * Solapi REST API v4 HMAC-SHA256 인증 헤더 생성
 */
function buildSolapiAuthHeader_(apiKey, apiSecret) {
  var date = new Date().toISOString();
  var salt = Utilities.getUuid().replace(/-/g, "");
  var sigBytes = Utilities.computeHmacSha256Signature(date + salt, apiSecret);
  var signature = sigBytes.map(function(b) {
    return ("0" + (b & 0xFF).toString(16)).slice(-2);
  }).join("");
  return "HMAC-SHA256 apiKey=" + apiKey + ", date=" + date + ", salt=" + salt + ", signature=" + signature;
}

/**
 * Solapi 잔액 조회 (GET /cash/v1/balance)
 */
function fetchSolapiBalance_(props) {
  var apiKey = String(props.getProperty("SOLAPI_API_KEY") || "").trim();
  var apiSecret = String(props.getProperty("SOLAPI_API_SECRET") || "").trim();
  if (!apiKey || !apiSecret) {
    return {
      ok: true,
      hasSolapiKey: false,
      balance: null,
      point: null,
      message: "솔라피 API 키가 아직 등록되지 않았습니다 (체험 모드)."
    };
  }

  var authHeader = buildSolapiAuthHeader_(apiKey, apiSecret);
  var resp = UrlFetchApp.fetch("https://api.solapi.com/cash/v1/balance", {
    method: "get",
    headers: {
      Authorization: authHeader,
      Accept: "application/json"
    },
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  var rawText = resp.getContentText();
  var parsed = {};
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {}

  if (code >= 200 && code < 300) {
    return {
      ok: true,
      hasSolapiKey: true,
      balance: parsed.balance != null ? Number(parsed.balance) : 0,
      point: parsed.point != null ? Number(parsed.point) : 0
    };
  }

  return {
    ok: false,
    hasSolapiKey: true,
    error: "SOLAPI_BALANCE_ERROR",
    message: "솔라피 잔액 조회 실패 (" + code + "): " + (parsed.errorMessage || parsed.message || rawText)
  };
}

/**
 * 카카오 알림톡 variables 객체 정규화 (키는 "#{변수명}", 값은 문자열 강제)
 */
function normalizeKakaoVariables_(vars) {
  var result = {};
  if (!vars || typeof vars !== "object") return result;
  var keys = Object.keys(vars);
  for (var i = 0; i < keys.length; i++) {
    var k = String(keys[i] || "").trim();
    if (!k) continue;
    var wrappedKey = (k.indexOf("#{") === 0 && k.slice(-1) === "}") ? k : ("#{" + k + "}");
    result[wrappedKey] = String(vars[keys[i]] == null ? "" : vars[keys[i]]);
  }
  return result;
}

/**
 * 브라우저 직접 접속 시 서버 정상 가동 안내
 */
function doGet() {
  var props = PropertiesService.getScriptProperties();
  var expectedPin = String(props.getProperty("APP_PIN") || "").trim();
  return jsonOut_({
    ok: true,
    service: "joonoo_sms",
    pinConfigured: Boolean(expectedPin),
    message: "주누디자인 고객 문자·알림톡 센터 백엔드(Code.gs)가 정상 가동 중입니다."
  });
}

/**
 * CORS Preflight(OPTIONS)를 발생시키지 않는 POST JSON 엔드포인트
 */
function doPost(e) {
  var raw = e && e.postData && e.postData.contents ? e.postData.contents : "";
  var data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return jsonOut_({
      ok: false,
      error: "INVALID_JSON",
      message: "요청 JSON 형식이 올바르지 않습니다."
    });
  }

  if (!data || typeof data !== "object") {
    return jsonOut_({
      ok: false,
      error: "EMPTY_PAYLOAD",
      message: "요청 데이터가 비어 있습니다."
    });
  }

  var action = String(data.action || "").trim();
  var props = PropertiesService.getScriptProperties();
  var expectedPin = String(props.getProperty("APP_PIN") || "").trim();
  var providedPin = String(data.pin || "").trim();

  // 0) 무인증 상태 점검 (민감 데이터 반환 없음)
  if (action === "ping") {
    return jsonOut_({
      ok: true,
      action: "ping",
      pinConfigured: Boolean(expectedPin),
      service: "joonoo_sms"
    });
  }

  // 1) 서버 환경설정 및 최초 사내 PIN 등록 (saveConfig)
  if (action === "saveConfig") {
    var lockCfg = LockService.getScriptLock();
    try {
      lockCfg.waitLock(10000);
      expectedPin = String(props.getProperty("APP_PIN") || "").trim();

      if (!expectedPin) {
        // 최초 1회 사내 PIN 신규 등록 허용
        var firstPin = String(data.newPin || data.pin || "").trim();
        if (firstPin.length < 4) {
          return jsonOut_({
            ok: false,
            error: "WEAK_PIN",
            message: "최초 설정할 사내 PIN 비밀번호는 4자리 이상 입력해 주세요."
          });
        }
        props.setProperty("APP_PIN", firstPin);
      } else {
        // 이미 설정된 경우 기존 PIN 일치 필수
        if (!providedPin || !safeEqual_(providedPin, expectedPin)) {
          return jsonOut_({
            ok: false,
            error: "INVALID_PIN",
            message: "기존 사내 PIN 비밀번호가 일치하지 않아 설정을 변경할 수 없습니다."
          });
        }
        var nextPin = String(data.newPin || "").trim();
        if (nextPin) {
          if (nextPin.length < 4) {
            return jsonOut_({
              ok: false,
              error: "WEAK_PIN",
              message: "변경할 새 PIN 비밀번호는 4자리 이상이어야 합니다."
            });
          }
          props.setProperty("APP_PIN", nextPin);
        }
      }

      if (typeof data.senderPhone === "string" && cleanDigits_(data.senderPhone)) {
        props.setProperty("SENDER_PHONE", cleanDigits_(data.senderPhone));
      } else if (!props.getProperty("SENDER_PHONE")) {
        props.setProperty("SENDER_PHONE", DEFAULT_SENDER_DIGITS_);
      }

      if (typeof data.pfId === "string") {
        props.setProperty("SOLAPI_PF_ID", data.pfId.trim());
      }

      if (data.clearSolapi === true) {
        props.deleteProperty("SOLAPI_API_KEY");
        props.deleteProperty("SOLAPI_API_SECRET");
      } else {
        var newApiKey = String(data.solapiApiKey || "").trim();
        var newApiSecret = String(data.solapiApiSecret || "").trim();
        if (newApiKey) props.setProperty("SOLAPI_API_KEY", newApiKey);
        if (newApiSecret) props.setProperty("SOLAPI_API_SECRET", newApiSecret);
      }

      var sheetsAfterCfg = ensureSheets_();
      var balanceAfterCfg = null;
      try {
        balanceAfterCfg = fetchSolapiBalance_(props);
      } catch (eBal) {}

      return jsonOut_({
        ok: true,
        action: "saveConfig",
        config: getMaskedConfig_(props),
        templates: readTemplates_(sheetsAfterCfg.tplSheet),
        history: readHistory_(sheetsAfterCfg.historySheet, 300),
        balanceInfo: balanceAfterCfg,
        message: "서버 설정 및 보안 키가 안전하게 저장되었습니다."
      });
    } finally {
      lockCfg.releaseLock();
    }
  }

  // 2) 공통 사내 PIN 검증 게이트
  if (!expectedPin) {
    return jsonOut_({
      ok: false,
      error: "PIN_NOT_CONFIGURED",
      pinConfigured: false,
      message: "아직 사내 PIN이 설정되지 않았습니다. 상단 [⚙️ 서버·솔라피 연결 설정]에서 최초 1회 PIN을 지정해 주세요."
    });
  }

  if (!providedPin || !safeEqual_(providedPin, expectedPin)) {
    return jsonOut_({
      ok: false,
      error: "INVALID_PIN",
      pinConfigured: true,
      message: "사내 PIN 비밀번호가 일치하지 않습니다."
    });
  }

  // 3) 설정 조회 (마스킹)
  if (action === "getConfig") {
    return jsonOut_({
      ok: true,
      action: "getConfig",
      config: getMaskedConfig_(props)
    });
  }

  // 4) 솔라피 잔액 조회
  if (action === "balance") {
    try {
      var balRes = fetchSolapiBalance_(props);
      return jsonOut_(balRes);
    } catch (errBal) {
      return jsonOut_({
        ok: false,
        error: "BALANCE_FETCH_FAILED",
        message: "잔액 조회 중 오류가 발생했습니다: " + String(errBal.message || errBal)
      });
    }
  }

  // 5) 초기 데이터 로드 및 실시간 동기화 (init / sync)
  if (action === "init" || action === "sync") {
    var sheets = ensureSheets_();
    var balanceInfo = null;
    if (data.includeBalance !== false) {
      try {
        balanceInfo = fetchSolapiBalance_(props);
      } catch (eInitBal) {}
    }
    return jsonOut_({
      ok: true,
      action: action,
      config: getMaskedConfig_(props),
      templates: readTemplates_(sheets.tplSheet),
      history: readHistory_(sheets.historySheet, 300),
      balanceInfo: balanceInfo
    });
  }

  // 6) 쓰기/발송 작업은 ScriptLock 직렬화로 동시성 보호
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    var ensured = ensureSheets_();

    // 6-A) 공용 상용구 추가 / 수정
    if (action === "saveTemplate") {
      var tpl = data.template || {};
      var tplId = String(tpl.id || ("tpl_" + Date.now())).trim();
      var category = String(tpl.category || "상담·안내").trim();
      var title = String(tpl.title || "").trim();
      var tplMode = String(tpl.mode || "SMS").trim().toUpperCase() === "ATA" ? "ATA" : "SMS";
      var subject = String(tpl.subject || "").trim();
      var body = String(tpl.body || "").trim();
      var solapiTplId = String(tpl.template_id || "").trim();
      var buttonsInfo = typeof tpl.buttons_info === "string"
        ? tpl.buttons_info
        : JSON.stringify(tpl.buttons_info || []);
      var staffName = String(data.staff || tpl.updated_by || "주누디자인").trim();
      var updatedAt = nowKst_();

      if (!title || !body) {
        return jsonOut_({
          ok: false,
          error: "INVALID_TEMPLATE",
          message: "상용구 제목과 본문 내용을 모두 입력해 주세요."
        });
      }

      var rowValues = [
        safeCell_(tplId),
        safeCell_(category),
        safeCell_(title),
        tplMode,
        safeCell_(subject),
        safeCell_(body),
        safeCell_(solapiTplId),
        buttonsInfo,
        safeCell_(staffName),
        updatedAt
      ];

      var tplSheet = ensured.tplSheet;
      var lastTplRow = tplSheet.getLastRow();
      var updatedExisting = false;

      if (lastTplRow > 1) {
        var existingIds = tplSheet.getRange(2, 1, lastTplRow - 1, 1).getValues();
        for (var rIdx = 0; rIdx < existingIds.length; rIdx++) {
          if (String(existingIds[rIdx][0]).trim() === tplId) {
            tplSheet.getRange(rIdx + 2, 1, 1, TEMPLATE_HEADERS_.length)
              .setNumberFormat("@")
              .setValues([rowValues]);
            updatedExisting = true;
            break;
          }
        }
      }

      if (!updatedExisting) {
        var nextRow = tplSheet.getLastRow() + 1;
        tplSheet.getRange(nextRow, 1, 1, TEMPLATE_HEADERS_.length)
          .setNumberFormat("@")
          .setValues([rowValues]);
      }

      return jsonOut_({
        ok: true,
        action: "saveTemplate",
        id: tplId,
        templates: readTemplates_(tplSheet),
        message: updatedExisting ? "공용 상용구가 수정되었습니다." : "새 공용 상용구가 추가되었습니다."
      });
    }

    // 6-B) 공용 상용구 삭제
    if (action === "deleteTemplate") {
      var targetId = String(data.id || "").trim();
      if (!targetId) {
        return jsonOut_({
          ok: false,
          error: "MISSING_ID",
          message: "삭제할 상용구 ID가 없습니다."
        });
      }

      var tSheet = ensured.tplSheet;
      var tLast = tSheet.getLastRow();
      var deleted = false;
      if (tLast > 1) {
        var ids = tSheet.getRange(2, 1, tLast - 1, 1).getValues();
        for (var dIdx = ids.length - 1; dIdx >= 0; dIdx--) {
          if (String(ids[dIdx][0]).trim() === targetId) {
            tSheet.deleteRow(dIdx + 2);
            deleted = true;
            break;
          }
        }
      }

      if (!deleted) {
        return jsonOut_({
          ok: false,
          error: "NOT_FOUND",
          message: "삭제할 상용구를 찾을 수 없습니다."
        });
      }

      return jsonOut_({
        ok: true,
        action: "deleteTemplate",
        id: targetId,
        templates: readTemplates_(tSheet),
        message: "공용 상용구가 삭제되었습니다."
      });
    }

    // 6-C) 문자 / 카카오 알림톡 발송 (action === "send")
    if (action === "send") {
      var cleanReceiver = cleanDigits_(data.phone);
      if (!/^01[016789]\d{7,8}$/.test(cleanReceiver) && !/^0\d{8,10}$/.test(cleanReceiver)) {
        return jsonOut_({
          ok: false,
          error: "INVALID_PHONE",
          message: "수신 고객 전화번호 형식이 올바르지 않습니다."
        });
      }

      var sendMode = String(data.mode || "SMS").trim().toUpperCase() === "ATA" ? "ATA" : "SMS";
      var staff = String(data.staff || "주누디자인(공용)").trim();
      var customerName = String(data.customerName || "").trim();
      var templateTitle = String(data.templateTitle || (sendMode === "ATA" ? "카카오 알림톡" : "일반 문자")).trim();
      var messageText = String(data.text || "").trim();
      var messagePreview = String(data.messagePreview || messageText).trim();
      var subjectText = String(data.subject || "").trim();
      var trackingInfo = String(data.trackingInfo || "").trim();
      var testMode = data.testMode === true;

      if (sendMode === "SMS" && !messageText) {
        return jsonOut_({
          ok: false,
          error: "EMPTY_MESSAGE",
          message: "발송할 문자 내용을 입력해 주세요."
        });
      }

      // 10초 이내 동일 고객번호 + 동일 내용 더블클릭 중복 발송 원천 차단
      var dedupRaw = cleanReceiver + "|" + sendMode + "|" + messagePreview;
      var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, dedupRaw);
      var dedupKey = "dedup_" + Utilities.base64EncodeWebSafe(digest).slice(0, 32);
      var cache = CacheService.getScriptCache();
      if (cache.get(dedupKey)) {
        return jsonOut_({
          ok: false,
          error: "DUPLICATE_WITHIN_10S",
          message: "동일 번호·동일 내용으로 10초 이내 중복 발송 요청이 감지되어 자동 차단되었습니다."
        });
      }

      var apiKey = String(props.getProperty("SOLAPI_API_KEY") || "").trim();
      var apiSecret = String(props.getProperty("SOLAPI_API_SECRET") || "").trim();
      var cleanSender = cleanDigits_(props.getProperty("SENDER_PHONE") || DEFAULT_SENDER_DIGITS_) || DEFAULT_SENDER_DIGITS_;
      var pfId = String(data.pfId || props.getProperty("SOLAPI_PF_ID") || "").trim();
      var hasSolapi = Boolean(apiKey && apiSecret);

      var sentAt = nowKst_();
      var recordId = "MSG_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
      var formattedPhone = formatKoreanPhone_(cleanReceiver);
      var statusLabel = "";
      var groupId = "";
      var simulated = false;

      if (testMode || !hasSolapi) {
        // 과금 없는 테스트 시뮬레이션 모드
        simulated = true;
        statusLabel = testMode ? "테스트발송(과금0원)" : "체험기록(솔라피미연동)";
        groupId = "SIM-" + Date.now();
      } else {
        // 실제 Solapi REST API v4 발송 호출
        var solapiMessage = {
          to: cleanReceiver,
          from: cleanSender
        };

        if (sendMode === "ATA") {
          var templateId = String(data.templateId || "").trim();
          if (!pfId) {
            return jsonOut_({
              ok: false,
              error: "PFID_MISSING",
              message: "카카오 비즈니스 채널 PFID가 설정되지 않았습니다. [서버·솔라피 설정]에서 PFID를 입력하거나 [회사번호 문자] 모드로 발송해 주세요."
            });
          }
          if (!templateId) {
            return jsonOut_({
              ok: false,
              error: "TEMPLATE_ID_MISSING",
              message: "선택한 상용구에 승인된 카카오 알림톡 템플릿 코드(templateId)가 없습니다. 상용구 수정에서 템플릿 코드를 입력하거나 [회사번호 문자] 탭으로 발송해 주세요."
            });
          }

          // 주의: Solapi v4 알림톡 발송 시 최상위 text 필드를 넣지 않고 kakaoOptions.variables만 전달
          solapiMessage.kakaoOptions = {
            pfId: pfId,
            templateId: templateId,
            variables: normalizeKakaoVariables_(data.variables || {}),
            disableSms: data.disableSms === true ? true : false
          };
        } else {
          solapiMessage.text = messageText;
          if (subjectText) {
            solapiMessage.subject = subjectText;
          }
        }

        var authHeader = buildSolapiAuthHeader_(apiKey, apiSecret);
        var solapiResp = UrlFetchApp.fetch("https://api.solapi.com/messages/v4/send-many/detail", {
          method: "post",
          contentType: "application/json; charset=utf-8",
          headers: {
            Authorization: authHeader,
            Accept: "application/json"
          },
          payload: JSON.stringify({ messages: [solapiMessage] }),
          muteHttpExceptions: true
        });

        var httpCode = solapiResp.getResponseCode();
        var respBody = solapiResp.getContentText();
        var solapiJson = {};
        try {
          solapiJson = JSON.parse(respBody);
        } catch (parseErr) {}

        if (httpCode < 200 || httpCode >= 300) {
          return jsonOut_({
            ok: false,
            error: "SOLAPI_HTTP_ERROR",
            message: "솔라피 발송 오류 (" + httpCode + "): " + (solapiJson.errorMessage || solapiJson.message || respBody)
          });
        }

        if (solapiJson.failedMessageList && solapiJson.failedMessageList.length > 0) {
          var firstFail = solapiJson.failedMessageList[0];
          return jsonOut_({
            ok: false,
            error: "SOLAPI_MESSAGE_REJECTED",
            message: "솔라피 발송 거부: " + (firstFail.statusMessage || firstFail.reason || "발신번호/템플릿 설정을 확인해 주세요.")
          });
        }

        groupId = (solapiJson.groupInfo && solapiJson.groupInfo.groupId)
          ? String(solapiJson.groupInfo.groupId)
          : String(solapiJson.groupId || "");
        statusLabel = sendMode === "ATA" ? "알림톡발송성공" : "문자발송성공";
      }

      // 10초 중복 방지 캐시 기록
      cache.put(dedupKey, "1", 10);

      // 발송내역 시트 저장 (문자열 포맷 강제로 010 앞자리 0 증발 원천 차단)
      var hSheet = ensured.historySheet;
      var newHRow = [
        recordId,
        sentAt,
        safeCell_(staff),
        safeCell_(customerName),
        formattedPhone,
        sendMode,
        safeCell_(templateTitle),
        safeCell_(messagePreview),
        safeCell_(trackingInfo),
        statusLabel,
        groupId
      ];
      var targetRowIdx = hSheet.getLastRow() + 1;
      hSheet.getRange(targetRowIdx, 1, 1, HISTORY_HEADERS_.length)
        .setNumberFormat("@")
        .setValues([newHRow]);

      var recordObj = {
        id: recordId,
        sent_at: sentAt,
        staff: staff,
        customer_name: customerName,
        phone: formattedPhone,
        mode: sendMode,
        template_title: templateTitle,
        message_preview: messagePreview,
        tracking_info: trackingInfo,
        status: statusLabel,
        group_id: groupId
      };

      return jsonOut_({
        ok: true,
        action: "send",
        simulated: simulated,
        record: recordObj,
        message: simulated
          ? "[테스트 발송 시뮬레이션] 실제 과금 없이 공용 발송대장에 정상 기록되었습니다."
          : (sendMode === "ATA"
              ? "카카오 알림톡 발송이 정상 접수되었습니다! (실패 시 회사번호 문자 자동대체)"
              : "회사번호(" + formatKoreanPhone_(cleanSender) + ")로 문자가 즉시 발송되었습니다!")
      });
    }

    return jsonOut_({
      ok: false,
      error: "UNKNOWN_ACTION",
      message: "지원하지 않는 요청 액션입니다: " + action
    });
  } finally {
    lock.releaseLock();
  }
}
