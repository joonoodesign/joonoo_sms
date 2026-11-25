/**
 * 주누디자인 ERP 연동형 고객 문자센터 (joonoo_sms v2.0) - Google Apps Script 백엔드
 * - 발신자 고정: 주누디자인 (053-267-3973) | 100% 순수 문자(SMS/LMS) 전용 (MMS/알림톡 원천 배제)
 * - 데이터 분리:
 *   1) 현재 스프레드시트(문자센터 전용 DB): [문자상용구], [문자발송내역] 2개 시트 자동 생성·관리
 *   2) 원격 접수대장 스프레드시트(1V7Xk0ILsci2QnRl8jFmYm-hPPskto1XbBgzAYvusr_c):
 *      오직 [배송데이터] 탭(gid=350646918, A:이름 | B:전화번호 | C:송장번호) 1개만 격리 접근 (나머지 시트 접근 0%)
 */

var DEFAULT_DELIVERY_SS_ID_ = "1V7Xk0ILsci2QnRl8jFmYm-hPPskto1XbBgzAYvusr_c";
var DELIVERY_SHEET_GID_ = 350646918;
var DELIVERY_SHEET_NAME_ = "배송데이터";
var DEFAULT_SENDER_PHONE_ = "0532673973";
var DEFAULT_RCS_BRAND_ID_ = "BR.k8k7pAWg8I";
var SERVER_VERSION_ = "2.6";

var SHEET_TEMPLATES_ = "문자상용구";
var SHEET_LOGS_ = "문자발송내역";

var LOG_HEADERS_ = [
  "id",
  "sent_at",
  "phone",
  "customer_name",
  "tracking_no",
  "msg_type",
  "byte_len",
  "message",
  "status",
  "result_detail",
  "source",
  "ref_id",
  "group_id"
];

var TPL_HEADERS_ = [
  "id",
  "title",
  "body",
  "sort_order",
  "updated_at"
];

var DEFAULT_TEMPLATES_ = [
  {
    id: "tpl_kakao_chat",
    title: "카톡 플친 상담창 연결",
    body: "[주누디자인] 안녕하세요 :) 인쇄 원고 전달 및 시안 상담은 아래 공식 카카오톡 상담창을 눌러 말씀 남겨주세요.\nhttps://pf.kakao.com/_xhlXFj/chat\n문의: 053-267-3973"
  },
  {
    id: "tpl_proof_check",
    title: "시안 확인 요청",
    body: "[주누디자인] 요청하신 디자인 시안 작업이 완료되었습니다.\n아래 카카오톡 상담창에서 오탈자 확인 후 [인쇄 확정] 또는 [수정 요청사항]을 남겨주세요.\nhttps://pf.kakao.com/_xhlXFj/chat\n(확정 후 인쇄가 진행되면 수정이 어렵습니다)"
  },
  {
    id: "tpl_bank_info",
    title: "농협 계좌 안내",
    body: "[주누디자인 입금계좌 안내]\n농협 351-1052-3914-03 (예금주: 전현수)\n입금 후 성함 말씀해 주시면 확인 후 바로 진행해 드리겠습니다. 감사합니다."
  },
  {
    id: "tpl_pickup_addr",
    title: "방문수령 주소",
    body: "[주누디자인 방문수령 안내]\n주소: 대구광역시 달서구 구마로39길 38\n고객센터: 053-267-3973\n방문 전 연락 부탁드립니다. 감사합니다."
  },
  {
    id: "tpl_print_guide",
    title: "인쇄 마감·출고 안내",
    body: "[주누디자인 출고 안내]\n시안 최종 확정 후 인쇄가 진행되며 한진택배로 출고됩니다.\n출고 후 수령까지 평균 1~2영업일(공휴일 제외) 소요됩니다.\n문의: 053-267-3973"
  }
];

/**
 * 최초 1회 편집기에서 실행하여 스프레드시트·외부통신 권한 승인 및 기본 시트를 준비할 때 사용합니다.
 */
function 초기권한승인및시트준비() {
  ensureLocalSheets_();
  var deliveryId = getDeliverySpreadsheetId_();
  var deliverySheet = getIsolatedDeliverySheet_(deliveryId);
  Logger.log("로컬 DB 시트 준비 완료 & 배송데이터 탭 연결 확인 완료: " + deliverySheet.getName());
}

function jsonOut_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function nowKstStr_() {
  return Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd HH:mm:ss");
}

function todayKstPrefix_() {
  return Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd");
}

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

function safeCell_(val) {
  var s = String(val == null ? "" : val);
  if (/^[=+\-@]/.test(s)) {
    return "'" + s;
  }
  return s;
}

/**
 * EUC-KR 비호환 이모지/특수공백 안전 정제
 */
function sanitizeForEucKr_(text) {
  var s = String(text == null ? "" : text);
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, "");
  s = s.replace(/\u00A0/g, " ");
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, "-");
  s = s.replace(/📦/g, "[택배]")
       .replace(/🚚/g, "[배송]")
       .replace(/😊|😄|☺️|🙂/g, "^^")
       .replace(/❤️|💕|💖|♥️/g, "♥")
       .replace(/⭐|🌟/g, "★")
       .replace(/✅|☑️/g, "[확인]")
       .replace(/⚠️/g, "[안내]")
       .replace(/☎|☎️|📞/g, "TEL:");
  // 서로게이트 페어(나머지 컬러 이모지) 제거
  s = s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "");
  // 남은 변형선택자·키캡·ZWJ 제거 + EUC-KR에 없는 단일 기호 치환 (index.html과 동일 규칙)
  s = s.replace(/[\uFE0E\uFE0F\u20E3\u200D]/g, "")
       .replace(/❤/g, "♥").replace(/☺/g, "^^").replace(/[☑✔✓]/g, "[확인]").replace(/⚠/g, "[안내]")
       .replace(/[❌✖]/g, "X").replace(/⭕/g, "○").replace(/✨/g, "*").replace(/•/g, "·");
  return s;
}

function calcEucKrBytes_(text) {
  var s = String(text == null ? "" : text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  var bytes = 0;
  for (var i = 0; i < s.length; i++) {
    var code = s.charCodeAt(i);
    bytes += code <= 0x7F ? 1 : 2;
  }
  return bytes;
}

/**
 * 한국 휴대폰(010 등 10~11자리) 및 안심번호(050X 11~12자리) 정규화
 */
function isDateValue_(v) {
  return v instanceof Date || Object.prototype.toString.call(v) === "[object Date]";
}

function calcMod7String_(numStr) {
  var rem = 0;
  for (var i = 0; i < numStr.length; i++) {
    rem = (rem * 10 + (numStr.charCodeAt(i) - 48)) % 7;
  }
  return rem;
}

function normalizeReceiverPhone_(raw) {
  if (isDateValue_(raw)) {
    return { valid: false, clean: "", formatted: "", reason: "날짜형식오류", restoredZero: false, isSafeNum: false };
  }
  var orig = (typeof raw === "number" && isFinite(raw)) ? raw.toFixed(0) : String(raw == null ? "" : raw).trim();
  orig = orig.replace(/\.0+$/, "");
  if (!orig) return { valid: false, clean: "", formatted: "", reason: "번호 없음", restoredZero: false, isSafeNum: false };
  if (/e\+/i.test(orig)) {
    return { valid: false, clean: "", formatted: orig, reason: "엑셀 지수깨짐(E+)", restoredZero: false, isSafeNum: false };
  }

  var s = orig.replace(/^\+?82[\s\-]*(?:\(0\)[\s\-]*)?(?=[1-9]|0[1-9])0?/, "0");
  var digits = s.replace(/\D/g, "");
  var restoredZero = false;

  // 시트 숫자 서식으로 앞자리 0이 빠진 경우 복원 (010~019, 050)
  if (/^1[016789]\d{7,8}$/.test(digits)) {
    digits = "0" + digits;
    restoredZero = true;
  } else if (/^50\d{8,9}$/.test(digits)) {
    digits = "0" + digits;
    restoredZero = true;
  }

  var isMobile = /^01[016789]\d{7,8}$/.test(digits);
  var isSafeNum = /^050\d{8,9}$/.test(digits);

  if (!isMobile && !isSafeNum) {
    var reason = /^0(2|[3-6][1-5]|70)/.test(digits) ? "유선번호(문자수신불가)" : "번호형식오류";
    return { valid: false, clean: digits, formatted: orig, reason: reason, restoredZero: restoredZero, isSafeNum: false };
  }

  var formatted = digits;
  if (digits.length === 11) {
    formatted = digits.slice(0, 3) + "-" + digits.slice(3, 7) + "-" + digits.slice(7);
  } else if (digits.length === 12) {
    formatted = digits.slice(0, 4) + "-" + digits.slice(4, 8) + "-" + digits.slice(8);
  } else if (digits.length === 10) {
    formatted = digits.slice(0, 3) + "-" + digits.slice(3, 6) + "-" + digits.slice(6);
  }

  return {
    valid: true,
    clean: digits,
    formatted: formatted,
    reason: "",
    restoredZero: restoredZero,
    isSafeNum: isSafeNum
  };
}

function normalizeTrackingNo_(rawVal, displayVal) {
  if (isDateValue_(rawVal)) {
    return { valid: false, clean: "", reason: "날짜형식오류(송장아님)", mod7Warning: false };
  }
  var disp = String(displayVal == null ? "" : displayVal).trim();
  var rawStr = String(rawVal == null ? "" : rawVal).trim();
  var candidate = disp || rawStr;
  // 숫자 셀은 원값으로 먼저 복원 (열이 좁아 화면에 4.64E+11로 보여도 정상 송장으로 인식)
  if (typeof rawVal === "number" && isFinite(rawVal) && rawVal <= 9007199254740991) {
    candidate = rawVal.toFixed(0);
  } else if (/e\+/i.test(candidate) || /e\+/i.test(disp)) {
    return { valid: false, clean: "", reason: "송장 지수깨짐(E+)", mod7Warning: false };
  }
  // 소수점 .0 제거
  candidate = candidate.replace(/\.0+$/, "");
  var digits = candidate.replace(/\D/g, "");
  if (!digits) {
    return { valid: false, clean: "", reason: "송장번호 없음", mod7Warning: false };
  }
  if (/^01[016789]\d{7,8}$/.test(digits)) {
    return { valid: false, clean: digits, reason: "휴대폰번호 오기입(송장아님)", mod7Warning: false };
  }
  // 한진택배 국내 표준 운송장: 10자리 또는 12자리 숫자만 허용
  if (digits.length !== 10 && digits.length !== 12) {
    return { valid: false, clean: digits, reason: "한진택배 송장 오류(" + digits.length + "자리 · 10/12자리만 가능)", mod7Warning: false };
  }
  var mod7Warning = calcMod7String_(digits.slice(0, -1)) !== Number(digits.slice(-1));
  return { valid: true, clean: digits, reason: "", mod7Warning: mod7Warning };
}

function formatSenderDisplay_(digits) {
  var d = String(digits || DEFAULT_SENDER_PHONE_).replace(/\D/g, "") || DEFAULT_SENDER_PHONE_;
  if (d.indexOf("02") === 0) {
    return d.length === 9
      ? d.slice(0, 2) + "-" + d.slice(2, 5) + "-" + d.slice(5)
      : d.slice(0, 2) + "-" + d.slice(2, 6) + "-" + d.slice(6);
  }
  if (d.length === 10) return d.slice(0, 3) + "-" + d.slice(3, 6) + "-" + d.slice(6);
  if (d.length === 11) return d.slice(0, 3) + "-" + d.slice(3, 7) + "-" + d.slice(7);
  if (d.length === 8) return d.slice(0, 4) + "-" + d.slice(4);
  return d;
}

function getDeliverySpreadsheetId_() {
  var props = PropertiesService.getScriptProperties();
  var saved = String(props.getProperty("DELIVERY_SS_ID") || "").trim();
  return saved || DEFAULT_DELIVERY_SS_ID_;
}

/**
 * 원격 접수대장 통합 시트에서 오직 '배송데이터'(gid=350646918) 시트만 격리 조회
 * - 다른 11개 기밀 시트는 절대 읽거나 접근하지 않음
 */
function getIsolatedDeliverySheet_(spreadsheetId) {
  var targetId = String(spreadsheetId || "").trim() || getDeliverySpreadsheetId_();
  var ss = SpreadsheetApp.openById(targetId);
  var sheets = ss.getSheets();
  var matched = null;

  // 1순위: 고유 시트 ID(gid=350646918) + 이름 확인
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === DELIVERY_SHEET_GID_) {
      matched = sheets[i];
      break;
    }
  }
  // 2순위: 이름 trim 매칭 ('배송데이터')
  if (!matched) {
    for (var j = 0; j < sheets.length; j++) {
      if (String(sheets[j].getName() || "").trim() === DELIVERY_SHEET_NAME_) {
        matched = sheets[j];
        break;
      }
    }
  }

  if (!matched) {
    throw new Error("지정된 스프레드시트에서 '배송데이터' 탭을 찾을 수 없습니다.");
  }
  return matched;
}

function ensureLocalSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var tplSheet = ss.getSheetByName(SHEET_TEMPLATES_);
  if (!tplSheet) {
    tplSheet = ss.insertSheet(SHEET_TEMPLATES_);
  }
  if (tplSheet.getLastRow() === 0) {
    tplSheet.getRange(1, 1, 1, TPL_HEADERS_.length).setNumberFormat("@").setValues([TPL_HEADERS_]);
    tplSheet.setFrozenRows(1);
    var now = nowKstStr_();
    var seedRows = [];
    for (var i = 0; i < DEFAULT_TEMPLATES_.length; i++) {
      var t = DEFAULT_TEMPLATES_[i];
      seedRows.push([t.id, safeCell_(t.title), safeCell_(t.body), String(i + 1), now]);
    }
    tplSheet.getRange(2, 1, seedRows.length, TPL_HEADERS_.length).setNumberFormat("@").setValues(seedRows);
  }

  var logSheet = ss.getSheetByName(SHEET_LOGS_);
  if (!logSheet) {
    logSheet = ss.insertSheet(SHEET_LOGS_);
  }
  if (logSheet.getLastRow() === 0) {
    logSheet.getRange(1, 1, 1, LOG_HEADERS_.length).setNumberFormat("@").setValues([LOG_HEADERS_]);
    logSheet.setFrozenRows(1);
  }

  return { tplSheet: tplSheet, logSheet: logSheet };
}

var TPL_CACHE_KEY_ = "TPL_CACHE_V1";

function getBalanceCacheKey_(apiKey) {
  var k = String(apiKey || "").trim();
  return "BAL_CACHE_V1_" + (k ? k.slice(-8) : "NONE");
}

function invalidateTemplatesCache_() {
  try { CacheService.getScriptCache().remove(TPL_CACHE_KEY_); } catch (e) {}
}

function invalidateBalanceCache_(apiKey) {
  try {
    var cache = CacheService.getScriptCache();
    cache.remove(getBalanceCacheKey_(apiKey));
    cache.remove("BAL_CACHE_V1_NONE");
  } catch (e) {}
}

function readTemplatesCached_(tplSheet) {
  var cache = CacheService.getScriptCache();
  try {
    var hit = cache.get(TPL_CACHE_KEY_);
    if (hit) {
      var parsed = JSON.parse(hit);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {}
  var list = readTemplates_(tplSheet);
  try {
    var jsonStr = JSON.stringify(list);
    if (jsonStr.length < 90000) cache.put(TPL_CACHE_KEY_, jsonStr, 300);
  } catch (e2) {}
  return list;
}

function fetchSolapiBalanceCached_(apiKey, apiSecret, forceFresh) {
  var cacheKey = getBalanceCacheKey_(apiKey);
  var cache = CacheService.getScriptCache();
  if (!forceFresh) {
    try {
      var hit = cache.get(cacheKey);
      if (hit) {
        var parsed = JSON.parse(hit);
        if (parsed && typeof parsed.availableTotal === "number" && isFinite(parsed.availableTotal)) {
          return parsed;
        }
      }
    } catch (e) {}
  }
  var bal = fetchSolapiBalance_(apiKey, apiSecret);
  if (bal && typeof bal.availableTotal === "number" && isFinite(bal.availableTotal)) {
    try { cache.put(cacheKey, JSON.stringify(bal), 60); } catch (e2) {}
  }
  return bal;
}

function readTemplates_(tplSheet) {
  var lastRow = tplSheet.getLastRow();
  if (lastRow <= 1) return [];
  var vals = tplSheet.getRange(2, 1, lastRow - 1, TPL_HEADERS_.length).getDisplayValues();
  var list = [];
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    if (!r[0] && !r[1]) continue;
    list.push({
      id: String(r[0] || "").trim(),
      title: String(r[1] || "").replace(/^'/, ""),
      body: String(r[2] || "").replace(/^'/, ""),
      sortOrder: Number(r[3] || i + 1),
      updatedAt: String(r[4] || "")
    });
  }
  return list;
}

function readRecentLogs_(logSheet, limitCount) {
  var limit = limitCount || 250;
  var lastRow = logSheet.getLastRow();
  if (lastRow <= 1) return [];
  var totalDataRows = lastRow - 1;
  var startRow = Math.max(2, lastRow - limit + 1);
  var numRows = lastRow - startRow + 1;
  var vals = logSheet.getRange(startRow, 1, numRows, LOG_HEADERS_.length).getDisplayValues();
  var logs = [];
  for (var i = vals.length - 1; i >= 0; i--) {
    var r = vals[i];
    if (!r[0] && !r[2]) continue;
    logs.push({
      id: String(r[0] || ""),
      sentAt: String(r[1] || ""),
      phone: String(r[2] || "").replace(/^'/, ""),
      customerName: String(r[3] || "").replace(/^'/, ""),
      trackingNo: String(r[4] || "").replace(/^'/, ""),
      msgType: String(r[5] || "SMS"),
      byteLen: Number(r[6] || 0),
      message: String(r[7] || "").replace(/^'/, ""),
      status: String(r[8] || ""),
      resultDetail: String(r[9] || "").replace(/^'/, ""),
      source: String(r[10] || "manual"),
      refId: String(r[11] || "")
    });
  }
  return logs;
}

/**
 * 최근 로그에서 이미 발송 성공한 (정규화전화번호|송장번호) 및 당일 전화번호 집합 생성
 */
function buildSentIndex_(logSheet) {
  var lastRow = logSheet.getLastRow();
  var sentPairMap = {};
  var todayPhoneMap = {};
  if (lastRow <= 1) {
    return { sentPairMap: sentPairMap, todayPhoneMap: todayPhoneMap };
  }
  var startRow = Math.max(2, lastRow - 1500 + 1);
  var vals = logSheet.getRange(startRow, 1, lastRow - startRow + 1, LOG_HEADERS_.length).getDisplayValues();
  var todayPrefix = todayKstPrefix_();

  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    var status = String(r[8] || "");
    if (status.indexOf("실패") !== -1) continue;
    // 과금 없는 테스트(체험발송) 기록은 '발송됨'으로 보지 않음 (단, 구버전 호환 직접발송 기록 DIRECT_SENT는 실제 발송)
    if (status.indexOf("체험") !== -1 && String(r[11] || "") !== "DIRECT_SENT") continue;
    var sentAt = String(r[1] || "");
    var cleanPhone = String(r[2] || "").replace(/\D/g, "");
    var trackingRaw = String(r[4] || "").replace(/^'/, "");
    if (!cleanPhone) continue;

    if (sentAt.indexOf(todayPrefix) === 0 && !todayPhoneMap[cleanPhone]) {
      todayPhoneMap[cleanPhone] = sentAt.slice(11, 16) || sentAt;
    }

    if (trackingRaw) {
      var visitMatch = trackingRaw.match(/^(?:방문\(|VISIT_)(\d{4}-\d{2}-\d{2})\)?$/);
      if (visitMatch) {
        sentPairMap[cleanPhone + "|VISIT_" + visitMatch[1]] = sentAt;
      } else {
        var parts = trackingRaw.split(/[,\s/]+/);
        for (var k = 0; k < parts.length; k++) {
          var tDigits = parts[k].replace(/\D/g, "");
          if (tDigits) {
            sentPairMap[cleanPhone + "|" + tDigits] = sentAt;
          }
        }
      }
    }
    var srcCol = String(r[10] || "").trim();
    if (srcCol === "visit" && sentAt.indexOf(todayPrefix) === 0) {
      sentPairMap[cleanPhone + "|VISIT_" + todayPrefix] = sentAt;
    }
  }
  return { sentPairMap: sentPairMap, todayPhoneMap: todayPhoneMap };
}

function getMaskedConfig_() {
  var props = PropertiesService.getScriptProperties();
  var apiKey = String(props.getProperty("SOLAPI_API_KEY") || "").trim();
  var apiSecret = String(props.getProperty("SOLAPI_API_SECRET") || "").trim();
  var sender = String(props.getProperty("SENDER_PHONE") || DEFAULT_SENDER_PHONE_).replace(/\D/g, "") || DEFAULT_SENDER_PHONE_;
  var deliverySsId = getDeliverySpreadsheetId_();
  var relayUrl = String(props.getProperty("RELAY_URL") || "").trim();
  var relayToken = String(props.getProperty("RELAY_TOKEN") || "").trim();

  var maskedKey = "";
  if (apiKey.length > 6) {
    maskedKey = apiKey.slice(0, 4) + "****" + apiKey.slice(-2);
  } else if (apiKey) {
    maskedKey = "****";
  }

  return {
    hasSolapiKey: Boolean(apiKey && apiSecret),
    maskedApiKey: maskedKey,
    senderPhone: formatSenderDisplay_(sender),
    senderDigits: sender,
    deliverySpreadsheetId: deliverySsId,
    relayActive: Boolean(relayUrl && relayToken),
    relayUrl: relayUrl
  };
}

function computeHmacHex_(message, secret) {
  var sigBytes = Utilities.computeHmacSha256Signature(message, secret, Utilities.Charset.UTF_8);
  var hexParts = [];
  for (var i = 0; i < sigBytes.length; i++) {
    var b = sigBytes[i] & 0xFF;
    hexParts.push((b < 16 ? "0" : "") + b.toString(16));
  }
  return hexParts.join("");
}

/**
 * Solapi REST API v4 HMAC-SHA256 서명 생성 (signed byte 안전 변환)
 */
function buildSolapiAuthHeader_(apiKey, apiSecret) {
  var date = new Date().toISOString();
  var salt = Utilities.getUuid().replace(/-/g, "");
  var sigHex = computeHmacHex_(date + salt, apiSecret);
  return "HMAC-SHA256 apiKey=" + apiKey + ", date=" + date + ", salt=" + salt + ", signature=" + sigHex;
}

/**
 * 카페24 고정 IP 중계기(설정 시) 또는 직접 호출 통합 게이트웨이
 */
function callSolapiApi_(method, path, payloadObj, apiKey, apiSecret) {
  var props = PropertiesService.getScriptProperties();
  var relayUrl = String(props.getProperty("RELAY_URL") || "").trim();
  var relayToken = String(props.getProperty("RELAY_TOKEN") || "").trim();

  if (relayUrl && relayToken) {
    var ts = String(Math.floor(Date.now() / 1000));
    var nonce = Utilities.getUuid().replace(/-/g, "");
    var relayBody = JSON.stringify({
      method: String(method || "GET").toUpperCase(),
      path: path,
      body: payloadObj || null,
      auth: (apiKey && apiSecret) ? buildSolapiAuthHeader_(apiKey, apiSecret) : "",
      ts: ts,
      nonce: nonce
    });
    var sig = computeHmacHex_(relayBody, relayToken);
    var rResp = UrlFetchApp.fetch(relayUrl, {
      method: "post",
      contentType: "application/json; charset=utf-8",
      headers: {
        "X-Joonoo-Sig": sig,
        "User-Agent": "Mozilla/5.0 JoonooSmsRelay/2.2"
      },
      payload: relayBody,
      muteHttpExceptions: true
    });
    var rCode = rResp.getResponseCode();
    var rParsed = {};
    try {
      rParsed = JSON.parse(rResp.getContentText());
    } catch (re) {}
    if (!rParsed || !rParsed.relayOk) {
      throw new Error((rParsed && rParsed.relayError) || ("고정IP 중계서버 응답 오류(HTTP " + rCode + ")"));
    }
    return {
      code: Number(rParsed.httpCode || 500),
      parsed: rParsed.solapi || {}
    };
  }

  var opts = {
    method: String(method || "get").toLowerCase(),
    headers: {
      Authorization: buildSolapiAuthHeader_(apiKey, apiSecret)
    },
    muteHttpExceptions: true
  };
  if (payloadObj) {
    opts.contentType = "application/json";
    opts.payload = JSON.stringify(payloadObj);
  }
  var resp = UrlFetchApp.fetch("https://api.solapi.com" + path, opts);
  var code = resp.getResponseCode();
  var parsed = {};
  try {
    parsed = JSON.parse(resp.getContentText());
  } catch (e) {}
  return { code: code, parsed: parsed };
}

function fetchSolapiBalance_(apiKey, apiSecret) {
  var res = callSolapiApi_("GET", "/cash/v1/balance", null, apiKey, apiSecret);
  var code = res.code;
  var parsed = res.parsed;
  if (code < 200 || code >= 300) {
    throw new Error(parsed.errorMessage || parsed.message || ("솔라피 잔액 조회 오류(HTTP " + code + ")"));
  }
  var balance = Number(parsed.balance || 0);
  var point = Number(parsed.point || 0);
  return {
    balance: balance,
    point: point,
    availableTotal: balance + point
  };
}

/**
 * PIN 무차별 대입 차단 (10회 연속 실패 시 10분 잠금)
 */
function verifyPinWithRateLimit_(providedPin, expectedPin) {
  var cache = CacheService.getScriptCache();
  var failKey = "PIN_FAIL_COUNT_V2";
  var failCount = Number(cache.get(failKey) || "0");
  if (failCount >= 10) {
    return { ok: false, error: "RATE_LIMITED", message: "비밀번호 오류가 10회 누적되어 10분간 잠겼습니다. 잠시 후 다시 시도해 주세요." };
  }
  if (!providedPin || !safeEqual_(providedPin, expectedPin)) {
    cache.put(failKey, String(failCount + 1), 600);
    return { ok: false, error: "INVALID_PIN", message: "사내 PIN 비밀번호가 올바르지 않습니다." };
  }
  if (failCount > 0) {
    cache.remove(failKey);
  }
  return { ok: true };
}

/**
 * 제목줄(택배출고발송/방문문자 섹션줄 또는 이름|전화번호|송장번호 컬럼줄) 판별
 * — 실제 전화번호/송장 숫자가 들어있으면 제목줄 아님 ('김고객' 오탐 방지)
 */
function isDeliveryHeaderRow_(row) {
  var cells = (row || []).slice(0, 10).map(function (v) { return String(v == null ? "" : v).replace(/\s+/g, ""); });
  for (var i = 0; i < cells.length; i++) {
    if (normalizeReceiverPhone_(cells[i]).valid || /^\d{9,16}$/.test(cells[i])) return false;
  }
  return /이름|성명|수령인|받는분|고객명|전화|연락처|휴대폰|송장|운송장|등기|택배|출고|방문|문자/.test(cells.join("|"));
}

/**
 * 1행(택배출고발송 / 방문문자) + 2행(이름|전화번호|송장번호 | | 이름|전화번호) 2단 헤더 및 구버전 1단 헤더 자동 감지
 */
function detectDeliveryLayout_(dispVals) {
  var layout = {
    headerRowCount: 0,
    nameCol: 0,
    phoneCol: 1,
    trackCol: 2,
    visitNameCol: -1,
    visitPhoneCol: -1
  };
  if (!dispVals || dispVals.length === 0) return layout;

  var r0Header = isDeliveryHeaderRow_(dispVals[0]);
  var r1Header = dispVals.length > 1 && isDeliveryHeaderRow_(dispVals[1]);
  if (r0Header && r1Header) {
    layout.headerRowCount = 2;
  } else if (r0Header) {
    layout.headerRowCount = 1;
  } else {
    layout.headerRowCount = 0;
  }

  // 1행 섹션 배너에서 '방문' 시작 열 탐색 (예: E1 = '방문문자' -> index 4)
  var visitStartHint = -1;
  if (layout.headerRowCount >= 1) {
    var topRow = dispVals[0] || [];
    for (var c0 = 0; c0 < topRow.length; c0++) {
      var t0 = String(topRow[c0] || "").replace(/\s+/g, "");
      if (t0 && /방문/.test(t0) && c0 >= 3) {
        visitStartHint = c0;
        break;
      }
    }
  }

  // 컬럼 헤더 행(2단이면 2행, 1단이면 1행)에서 택배/방문 열 매핑
  if (layout.headerRowCount >= 1) {
    var hdr = dispVals[layout.headerRowCount - 1] || [];
    var splitCol = visitStartHint >= 0 ? visitStartHint : 4;
    var foundName = false, foundPhone = false, foundTrack = false;
    for (var c = 0; c < Math.min(hdr.length, splitCol); c++) {
      var hc = String(hdr[c] || "").replace(/\s+/g, "");
      if (!foundName && /이름|성명|수령인|받는분성명|고객명/.test(hc)) { layout.nameCol = c; foundName = true; }
      else if (!foundPhone && /전화|휴대폰|연락처|핸드폰/.test(hc)) { layout.phoneCol = c; foundPhone = true; }
      else if (!foundTrack && /송장|운송장|등기번호/.test(hc)) { layout.trackCol = c; foundTrack = true; }
    }
    var foundVName = false, foundVPhone = false;
    for (var vc = Math.max(3, visitStartHint >= 0 ? visitStartHint : 3); vc < hdr.length; vc++) {
      var vhc = String(hdr[vc] || "").replace(/\s+/g, "");
      if (!foundVName && /이름|성명|수령인|받는분성명|고객명/.test(vhc)) { layout.visitNameCol = vc; foundVName = true; }
      else if (!foundVPhone && /전화|휴대폰|연락처|핸드폰/.test(vhc)) { layout.visitPhoneCol = vc; foundVPhone = true; }
    }
    if (visitStartHint >= 0 && layout.visitNameCol < 0 && layout.visitPhoneCol < 0) {
      layout.visitNameCol = visitStartHint;
      layout.visitPhoneCol = visitStartHint + 1;
    }
  }
  return layout;
}

function cellToSafeText_(val) {
  if (val == null || val === "" || typeof val === "boolean") return "";
  if (isDateValue_(val)) return "";
  if (typeof val === "number" && isFinite(val)) return val.toFixed(0);
  return String(val).trim();
}

function readDeliverySheetRows_(logSheet) {
  var deliverySheet = getIsolatedDeliverySheet_(getDeliverySpreadsheetId_());
  var lastRow = deliverySheet.getLastRow();
  if (lastRow === 0) {
    return { rows: [], visitRows: [], sheetName: deliverySheet.getName(), headerRowCount: 0 };
  }
  var colCount = Math.max(6, Math.min(deliverySheet.getLastColumn(), 10));
  var range = deliverySheet.getRange(1, 1, lastRow, colCount);
  // 1회 원격 읽기(getValues)로 속도 2배 개선 (Date/Boolean/지수깨짐/010~019 앞0 복원 가드 완비)
  var rawVals = range.getValues();
  var topCount = Math.min(2, rawVals.length);
  var headerPreview = [];
  for (var h = 0; h < topCount; h++) {
    headerPreview.push(rawVals[h].map(function (v) { return cellToSafeText_(v); }));
  }

  var layout = detectDeliveryLayout_(headerPreview);
  var startIdx = layout.headerRowCount;
  var todayStr = todayKstPrefix_();
  var sentIdx = buildSentIndex_(logSheet);
  var resultRows = [];
  var visitRows = [];

  for (var r = startIdx; r < rawVals.length; r++) {
    var vRow = rawVals[r];

    // 1) 좌측: 택배출고발송 (A:이름 | B:전화번호 | C:송장번호)
    var valName = vRow[layout.nameCol];
    var valPhone = vRow[layout.phoneCol];
    var valTrack = vRow[layout.trackCol];
    var rawName = cellToSafeText_(valName);
    var rawPhone = isDateValue_(valPhone) ? "[날짜]" : cellToSafeText_(valPhone);
    var dispTrack = isDateValue_(valTrack) ? "[날짜]" : cellToSafeText_(valTrack);

    if (rawName || rawPhone || dispTrack) {
      var isDupHdr = rawName.replace(/\s+/g, "") === "이름" && /전화|연락처/.test(rawPhone) && /송장/.test(dispTrack);
      if (!isDupHdr) {
        var pInfo = normalizeReceiverPhone_(valPhone);
        var tInfo = normalizeTrackingNo_(valTrack, dispTrack);
        var pairKey = (pInfo.clean || "") + "|" + (tInfo.clean || "");
        var alreadySentAt = (pInfo.valid && tInfo.valid && sentIdx.sentPairMap[pairKey]) ? sentIdx.sentPairMap[pairKey] : "";

        resultRows.push({
          sheetRow: r + 1,
          customerName: rawName,
          rawPhone: rawPhone,
          phone: pInfo.valid ? pInfo.formatted : rawPhone,
          cleanPhone: pInfo.clean,
          phoneValid: pInfo.valid,
          phoneReason: pInfo.reason,
          restoredZero: pInfo.restoredZero,
          isSafeNum: pInfo.isSafeNum,
          rawTracking: dispTrack,
          trackingNo: tInfo.clean || dispTrack,
          trackingValid: tInfo.valid,
          trackingReason: tInfo.reason,
          mod7Warning: Boolean(tInfo.mod7Warning),
          alreadySentAt: alreadySentAt
        });
      }
    }

    // 2) 우측: 방문문자 (E:이름 | F:전화번호)
    if (layout.visitNameCol >= 0 && layout.visitPhoneCol >= 0 && layout.visitPhoneCol < vRow.length) {
      var valVName = vRow[layout.visitNameCol];
      var valVPhone = vRow[layout.visitPhoneCol];
      var rawVName = cellToSafeText_(valVName);
      var rawVPhone = isDateValue_(valVPhone) ? "[날짜]" : cellToSafeText_(valVPhone);
      if (rawVName || rawVPhone) {
        var isDupVHdr = rawVName.replace(/\s+/g, "") === "이름" && /전화|연락처/.test(rawVPhone);
        if (!isDupVHdr) {
          var vpInfo = normalizeReceiverPhone_(valVPhone);
          var visitKey = (vpInfo.clean || "") + "|VISIT_" + todayStr;
          var visitSentAt = (vpInfo.valid && sentIdx.sentPairMap[visitKey]) ? sentIdx.sentPairMap[visitKey] : "";

          visitRows.push({
            sheetRow: r + 1,
            customerName: rawVName,
            rawPhone: rawVPhone,
            phone: vpInfo.valid ? vpInfo.formatted : rawVPhone,
            cleanPhone: vpInfo.clean,
            phoneValid: vpInfo.valid,
            phoneReason: vpInfo.reason,
            restoredZero: vpInfo.restoredZero,
            isSafeNum: vpInfo.isSafeNum,
            alreadySentAt: visitSentAt
          });
        }
      }
    }
  }

  return {
    rows: resultRows,
    visitRows: visitRows,
    sheetName: deliverySheet.getName(),
    headerRowCount: layout.headerRowCount
  };
}

function doGet() {
  return jsonOut_({
    ok: true,
    service: "joonoo_sms",
    version: SERVER_VERSION_,
    sender: "053-267-3973"
  });
}

function doPost(e) {
  try {
    var raw = e && e.postData && e.postData.contents ? e.postData.contents : "";
    var data;
    try {
      data = JSON.parse(raw);
    } catch (parseErr) {
      return jsonOut_({ ok: false, error: "INVALID_JSON", message: "요청 데이터 형식이 올바르지 않습니다." });
    }

    if (!data || typeof data !== "object") {
      return jsonOut_({ ok: false, error: "EMPTY_BODY", message: "요청 데이터가 비어 있습니다." });
    }

    var action = String(data.action || "").trim();
    var props = PropertiesService.getScriptProperties();
    var expectedPin = String(props.getProperty("APP_PIN") || "").trim();
    var providedPin = String(data.pin || "").trim();

    // 최초 1회 PIN 미설정 상태에서는 saveConfig로만 초기 PIN 등록 허용
    if (!expectedPin) {
      if (action !== "saveConfig") {
        return jsonOut_({
          ok: false,
          error: "PIN_NOT_CONFIGURED",
          message: "최초 1회 [⚙️ 설정]에서 사내 공용 PIN 비밀번호를 먼저 등록해 주세요."
        });
      }
      var newInitPin = String(data.newPin || data.pin || "").trim();
      if (newInitPin.length < 4) {
        return jsonOut_({ ok: false, error: "WEAK_PIN", message: "사내 PIN은 4자리 이상으로 설정해 주세요." });
      }
      props.setProperty("APP_PIN", newInitPin);
      expectedPin = newInitPin;
      providedPin = newInitPin;
    } else {
      var pinCheck = verifyPinWithRateLimit_(providedPin, expectedPin);
      if (!pinCheck.ok) {
        return jsonOut_(pinCheck);
      }
    }

    // 1. 설정 저장
    if (action === "saveConfig") {
      var lockCfg = LockService.getScriptLock();
      if (!lockCfg.tryLock(15000)) {
        return jsonOut_({ ok: false, error: "BUSY", message: "설정 저장 중입니다. 잠시 후 다시 시도해 주세요." });
      }
      try {
        if (data.newPin && String(data.newPin).trim().length >= 4) {
          props.setProperty("APP_PIN", String(data.newPin).trim());
        }
        if (data.solapiApiKey && String(data.solapiApiKey).trim()) {
          props.setProperty("SOLAPI_API_KEY", String(data.solapiApiKey).trim());
        }
        if (data.solapiApiSecret && String(data.solapiApiSecret).trim()) {
          props.setProperty("SOLAPI_API_SECRET", String(data.solapiApiSecret).trim());
        }
        if (data.senderPhone) {
          var cleanSender = String(data.senderPhone).replace(/\D/g, "");
          if (cleanSender.length >= 8) {
            props.setProperty("SENDER_PHONE", cleanSender);
          }
        }
        if (data.deliverySpreadsheetId && String(data.deliverySpreadsheetId).trim()) {
          var ssInput = String(data.deliverySpreadsheetId).trim();
          var idMatch = ssInput.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
          props.setProperty("DELIVERY_SS_ID", idMatch ? idMatch[1] : ssInput);
        }
        if (data.relayUrl !== undefined) {
          var ru = String(data.relayUrl || "").trim();
          if (!ru || ru === "CLEAR") props.deleteProperty("RELAY_URL");
          else props.setProperty("RELAY_URL", ru);
        }
        if (data.relayToken !== undefined) {
          var rt = String(data.relayToken || "").trim();
          if (!rt || rt === "CLEAR") props.deleteProperty("RELAY_TOKEN");
          else props.setProperty("RELAY_TOKEN", rt);
        }
        ensureLocalSheets_();
        invalidateBalanceCache_(props.getProperty("SOLAPI_API_KEY"));
        return jsonOut_({
          ok: true,
          action: "saveConfig",
          config: getMaskedConfig_()
        });
      } finally {
        SpreadsheetApp.flush();
        lockCfg.releaseLock();
      }
    }

    // 2. 초기 로드 / 동기화 (상용구 + 최근 발송내역 + 설정 마스킹 정보 + 잔액)
    if (action === "init" || action === "sync") {
      var sheets = ensureLocalSheets_();
      var templates = readTemplatesCached_(sheets.tplSheet);
      var logs = readRecentLogs_(sheets.logSheet, 250);
      var cfg = getMaskedConfig_();
      var balanceInfo = null;
      var forceFresh = Boolean(data.forceFreshBalance);

      if (cfg.hasSolapiKey && data.includeBalance !== false) {
        try {
          balanceInfo = fetchSolapiBalanceCached_(
            props.getProperty("SOLAPI_API_KEY"),
            props.getProperty("SOLAPI_API_SECRET"),
            forceFresh
          );
        } catch (balErr) {
          balanceInfo = { error: String(balErr.message || balErr) };
        }
      }

      return jsonOut_({
        ok: true,
        action: action,
        serverVersion: SERVER_VERSION_,
        config: cfg,
        // 중계기(relayActive) 활성 시 브라우저에 솔라피 평문 키 노출 차단 (보안+경량화)
        directCredentials: (!cfg.relayActive && cfg.hasSolapiKey) ? {
          apiKey: String(props.getProperty("SOLAPI_API_KEY") || "").trim(),
          apiSecret: String(props.getProperty("SOLAPI_API_SECRET") || "").trim()
        } : null,
        balance: balanceInfo,
        templates: templates,
        logs: logs
      });
    }

    // 2-1. 브라우저 직접 발송 내역 구글 시트 동기화 저장 (다중 PC 실시간 공유 & 중복발송 차단)
    if (action === "recordLogs") {
      var recResults = Array.isArray(data.results) ? data.results : [];
      if (recResults.length === 0) {
        return jsonOut_({ ok: true, action: "recordLogs", recordedCount: 0 });
      }
      var lockRec = LockService.getScriptLock();
      if (!lockRec.tryLock(15000)) {
        return jsonOut_({ ok: false, error: "BUSY", message: "발송 내역 기록 중입니다. 잠시 후 다시 시도해 주세요." });
      }
      try {
        var recSheets = ensureLocalSheets_();
        var logSheetRec = recSheets.logSheet;
        var nowRec = nowKstStr_();
        var appendRows = [];
        for (var rIdx = 0; rIdx < recResults.length; rIdx++) {
          var item = recResults[rIdx] || {};
          var rowId = "dir_" + Utilities.getUuid().replace(/-/g, "").slice(0, 12);
          appendRows.push([
            rowId,
            nowRec,
            safeCell_(item.phone || ""),
            safeCell_(item.customerName || ""),
            safeCell_(item.trackingNo || ""),
            safeCell_(item.msgType || "SMS"),
            String(item.byteLen || 0),
            safeCell_(item.message || ""),
            safeCell_(item.status || "완료"),
            safeCell_(item.detail || "직접발송"),
            safeCell_(item.source || "manual"),
            safeCell_(item.refId || "DIRECT_SENT"),
            safeCell_(item.groupId || "")
          ]);
        }
        if (appendRows.length > 0) {
          var startRowRec = logSheetRec.getLastRow() + 1;
          logSheetRec.getRange(startRowRec, 1, appendRows.length, LOG_HEADERS_.length)
            .setNumberFormat("@")
            .setValues(appendRows);
          invalidateBalanceCache_(props.getProperty("SOLAPI_API_KEY"));
        }
        return jsonOut_({
          ok: true,
          action: "recordLogs",
          recordedCount: appendRows.length,
          logs: readRecentLogs_(logSheetRec, 250)
        });
      } finally {
        SpreadsheetApp.flush();
        lockRec.releaseLock();
      }
    }

    // 3. 잔액 단독 조회
    if (action === "balance") {
      var cfgBal = getMaskedConfig_();
      if (!cfgBal.hasSolapiKey) {
        return jsonOut_({ ok: true, hasSolapiKey: false, balance: null });
      }
      var bal = fetchSolapiBalanceCached_(
        props.getProperty("SOLAPI_API_KEY"),
        props.getProperty("SOLAPI_API_SECRET"),
        Boolean(data.forceFreshBalance)
      );
      return jsonOut_({ ok: true, hasSolapiKey: true, balance: bal });
    }

    // 4. 공용 상용구 추가/수정 (고유 ID 기준 처리)
    if (action === "saveTemplate") {
      var title = sanitizeForEucKr_(String(data.title || "").trim());
      var body = sanitizeForEucKr_(String(data.body || "").trim());
      if (!title || title.length > 60) {
        return jsonOut_({ ok: false, error: "INVALID_TITLE", message: "상용구 버튼 이름은 1~60자 이내로 입력해 주세요." });
      }
      if (!body || calcEucKrBytes_(body) > 2000) {
        return jsonOut_({ ok: false, error: "INVALID_BODY", message: "상용구 내용은 2,000바이트 이내로 입력해 주세요." });
      }

      var lockTpl = LockService.getScriptLock();
      if (!lockTpl.tryLock(15000)) {
        return jsonOut_({ ok: false, error: "BUSY", message: "다른 직원이 상용구를 저장 중입니다. 잠시 후 다시 시도해 주세요." });
      }
      try {
        var tplSheets = ensureLocalSheets_();
        var tplSheet = tplSheets.tplSheet;
        var tplId = String(data.id || ("tpl_" + Utilities.getUuid().slice(0, 8))).trim();
        var nowStr = nowKstStr_();
        var lastR = tplSheet.getLastRow();
        var updated = false;

        if (lastR > 1) {
          var ids = tplSheet.getRange(2, 1, lastR - 1, 1).getDisplayValues();
          for (var idx = 0; idx < ids.length; idx++) {
            if (String(ids[idx][0] || "").trim() === tplId) {
              tplSheet.getRange(idx + 2, 1, 1, TPL_HEADERS_.length)
                .setNumberFormat("@")
                .setValues([[tplId, safeCell_(title), safeCell_(body), String(idx + 1), nowStr]]);
              updated = true;
              break;
            }
          }
        }
        if (!updated) {
          var nextOrder = Math.max(1, lastR);
          tplSheet.getRange(lastR + 1, 1, 1, TPL_HEADERS_.length)
            .setNumberFormat("@")
            .setValues([[tplId, safeCell_(title), safeCell_(body), String(nextOrder), nowStr]]);
        }

        invalidateTemplatesCache_();
        return jsonOut_({
          ok: true,
          action: "saveTemplate",
          templates: readTemplates_(tplSheet)
        });
      } finally {
        SpreadsheetApp.flush();
        lockTpl.releaseLock();
      }
    }

    // 5. 공용 상용구 삭제 (고유 ID 기준 안전 삭제)
    if (action === "deleteTemplate") {
      var targetTplId = String(data.id || "").trim();
      if (!targetTplId) {
        return jsonOut_({ ok: false, error: "MISSING_ID", message: "삭제할 상용구 ID가 없습니다." });
      }
      var lockDel = LockService.getScriptLock();
      if (!lockDel.tryLock(15000)) {
        return jsonOut_({ ok: false, error: "BUSY", message: "다른 직원이 상용구를 수정 중입니다. 잠시 후 다시 시도해 주세요." });
      }
      try {
        var delSheets = ensureLocalSheets_();
        var sTpl = delSheets.tplSheet;
        var lr = sTpl.getLastRow();
        if (lr > 1) {
          var idCol = sTpl.getRange(2, 1, lr - 1, 1).getDisplayValues();
          for (var d = idCol.length - 1; d >= 0; d--) {
            if (String(idCol[d][0] || "").trim() === targetTplId) {
              sTpl.deleteRow(d + 2);
              break;
            }
          }
        }
        invalidateTemplatesCache_();
        return jsonOut_({
          ok: true,
          action: "deleteTemplate",
          templates: readTemplates_(sTpl)
        });
      } finally {
        SpreadsheetApp.flush();
        lockDel.releaseLock();
      }
    }

    // 6. 원격 접수대장 통합 시트의 '배송데이터' 탭 실시간 불러오기 (택배 A:C + 방문 E:F 동시 반환)
    if (action === "loadDeliverySheet") {
      var localDb = ensureLocalSheets_();
      var loaded = readDeliverySheetRows_(localDb.logSheet);
      return jsonOut_({
        ok: true,
        action: "loadDeliverySheet",
        sheetName: loaded.sheetName,
        headerRowCount: loaded.headerRowCount,
        rows: loaded.rows,
        visitRows: loaded.visitRows || []
      });
    }

    // 7. 발송 완료된 행만 '배송데이터' 탭에서 안전 비우기 (1행 제목 유지 & 새로 추가된 미발송 행 보존!)
    if (action === "clearDeliverySent") {
      var lockClr = LockService.getScriptLock();
      if (!lockClr.tryLock(25000)) {
        return jsonOut_({ ok: false, error: "BUSY", message: "다른 직원이 작업 중입니다. 잠시 후 다시 시도해 주세요." });
      }
      try {
        var localForClr = ensureLocalSheets_();
        var sentIndex = buildSentIndex_(localForClr.logSheet);
        var clientKeys = Array.isArray(data.sentKeys) ? data.sentKeys : [];
        for (var ck = 0; ck < clientKeys.length; ck++) {
          sentIndex.sentPairMap[String(clientKeys[ck])] = "sent";
        }

        var dSheet = getIsolatedDeliverySheet_(getDeliverySpreadsheetId_());
        // 안전 가드: 반드시 시트 이름에 '배송데이터'가 일치해야 함
        if (String(dSheet.getName() || "").trim() !== DELIVERY_SHEET_NAME_) {
          return jsonOut_({ ok: false, error: "SHEET_GUARD", message: "안전 보호: 대상 탭 이름이 '배송데이터'가 아니므로 비우기를 중단했습니다." });
        }

        var dLastRow = dSheet.getLastRow();
        var topCntSent = Math.min(2, dLastRow);
        var topValsSent = topCntSent > 0 ? dSheet.getRange(1, 1, topCntSent, Math.max(6, dSheet.getLastColumn())).getDisplayValues() : [];
        var laySent = detectDeliveryLayout_(topValsSent);
        var startRowSent = laySent.headerRowCount + 1;
        if (dLastRow < startRowSent) {
          return jsonOut_({ ok: true, removedCount: 0, remainingCount: 0, rows: [], visitRows: [] });
        }

        var dRange = dSheet.getRange(startRowSent, 1, dLastRow - startRowSent + 1, 3);
        var rawRows = dRange.getValues();
        var dispRows = dRange.getDisplayValues();
        var keptRows = [];
        var removedCount = 0;

        for (var rIdx = 0; rIdx < dispRows.length; rIdx++) {
          var rDisp = dispRows[rIdx];
          var rRaw = rawRows[rIdx];
          var nm = String(rDisp[0] || "").trim();
          var ph = String(rDisp[1] || "").trim();
          var tr = String(rDisp[2] || "").trim();
          if (!nm && !ph && !tr) continue;

          var pNorm = normalizeReceiverPhone_(ph);
          var tNorm = normalizeTrackingNo_(rRaw[2], tr);
          var key = (pNorm.clean || "") + "|" + (tNorm.clean || "");

          if (pNorm.valid && tNorm.valid && sentIndex.sentPairMap[key]) {
            removedCount++;
          } else {
            keptRows.push([safeCell_(nm), safeCell_(ph), safeCell_(tNorm.clean || tr)]);
          }
        }

        // 헤더 이후 데이터 내용만 비우고(서식 보존), 미발송 행이 있으면 startRowSent부터 다시 채움
        dRange.clearContent();
        if (keptRows.length > 0) {
          dSheet.getRange(startRowSent, 1, keptRows.length, 3).setNumberFormat("@").setValues(keptRows);
        }

        var refreshed = readDeliverySheetRows_(localForClr.logSheet);
        return jsonOut_({
          ok: true,
          action: "clearDeliverySent",
          removedCount: removedCount,
          remainingCount: keptRows.length,
          rows: refreshed.rows,
          visitRows: refreshed.visitRows || []
        });
      } finally {
        SpreadsheetApp.flush();
        lockClr.releaseLock();
      }
    }

    // 7-1. '배송데이터' 탭 제목줄(1~2행)만 남기고 데이터 영역만 깨끗하게 비우기 (scope: 'delivery' | 'visit' | 'all')
    if (action === "clearDeliveryAll") {
      var lockAll = LockService.getScriptLock();
      if (!lockAll.tryLock(25000)) {
        return jsonOut_({ ok: false, error: "BUSY", message: "다른 직원이 작업 중입니다. 잠시 후 다시 시도해 주세요." });
      }
      try {
        var dSheetAll = getIsolatedDeliverySheet_(getDeliverySpreadsheetId_());
        if (String(dSheetAll.getName() || "").trim() !== DELIVERY_SHEET_NAME_) {
          return jsonOut_({ ok: false, error: "SHEET_GUARD", message: "안전 보호: 대상 탭 이름이 '배송데이터'가 아니므로 비우기를 중단했습니다." });
        }
        var scope = String(data.scope || "all").trim();
        var lastRowAll = dSheetAll.getLastRow();
        var removedAll = 0;
        if (lastRowAll >= 1) {
          var maxColAll = Math.min(dSheetAll.getMaxColumns(), Math.max(6, dSheetAll.getLastColumn()));
          var topCount = Math.min(2, lastRowAll);
          var topVals = dSheetAll.getRange(1, 1, topCount, maxColAll).getDisplayValues();
          var lay = detectDeliveryLayout_(topVals);
          var fromRow = lay.headerRowCount + 1;
          if (lastRowAll >= fromRow) {
            removedAll = lastRowAll - fromRow + 1;
            if (scope === "delivery") {
              dSheetAll.getRange(fromRow, 1, removedAll, 3).clearContent();
            } else if (scope === "visit") {
              var vStartCol = lay.visitNameCol >= 0 ? (lay.visitNameCol + 1) : 5;
              dSheetAll.getRange(fromRow, vStartCol, removedAll, 2).clearContent();
            } else {
              dSheetAll.getRange(fromRow, 1, removedAll, maxColAll).clearContent();
            }
          }
        }
        var localAfterAll = ensureLocalSheets_();
        var refreshedAll = readDeliverySheetRows_(localAfterAll.logSheet);
        return jsonOut_({
          ok: true,
          action: "clearDeliveryAll",
          scope: scope,
          removedCount: removedAll,
          remainingCount: (refreshedAll.rows.length + (refreshedAll.visitRows || []).length),
          rows: refreshedAll.rows,
          visitRows: refreshedAll.visitRows || []
        });
      } finally {
        SpreadsheetApp.flush();
        lockAll.releaseLock();
      }
    }

    // 8. 단건 및 다건 문자 통합 발송 (SMS / LMS 전용, Idempotency + LockService 이중 발송 완벽 방어)
    if (action === "send") {
      var requestId = String(data.requestId || "").trim();
      var cacheSvc = CacheService.getScriptCache();

      if (requestId) {
        var cachedResp = cacheSvc.get("REQ_IDEMP_" + requestId);
        if (cachedResp) {
          return ContentService.createTextOutput(cachedResp).setMimeType(ContentService.MimeType.JSON);
        }
      }

      var rawItems = Array.isArray(data.items) ? data.items : [];
      if (rawItems.length === 0 && data.phone) {
        rawItems = [{
          phone: data.phone,
          customerName: data.customerName || "",
          trackingNo: data.trackingNo || "",
          message: data.message || "",
          source: data.source || "manual",
          refId: data.refId || ""
        }];
      }

      if (rawItems.length === 0) {
        return jsonOut_({ ok: false, error: "NO_ITEMS", message: "발송할 대상이 없습니다." });
      }
      if (rawItems.length > 300) {
        return jsonOut_({ ok: false, error: "BATCH_TOO_LARGE", message: "한 번에 최대 300건씩 분할 발송됩니다." });
      }

      var lockSend = LockService.getScriptLock();
      if (!lockSend.tryLock(30000)) {
        return jsonOut_({ ok: false, error: "BUSY", message: "현재 다른 발송 요청을 처리 중입니다. 3초 후 다시 눌러주세요." });
      }

      try {
        var db = ensureLocalSheets_();
        var sentCheck = buildSentIndex_(db.logSheet);
        var skipAlreadySent = data.skipAlreadySent !== false;

        var validBatch = [];
        var skippedItems = [];
        var estimatedCost = 0;

        for (var m = 0; m < rawItems.length; m++) {
          var item = rawItems[m] || {};
          var p = normalizeReceiverPhone_(item.phone);
          var cleanMsg = sanitizeForEucKr_(item.message || "").trim();
          var byteLen = calcEucKrBytes_(cleanMsg);
          var trackStr = String(item.trackingNo || "").trim();

          if (!p.valid) {
            skippedItems.push({ phone: String(item.phone || ""), customerName: String(item.customerName || ""), reason: p.reason });
            continue;
          }
          if (!cleanMsg) {
            skippedItems.push({ phone: p.formatted, customerName: String(item.customerName || ""), reason: "문자 내용 비어있음" });
            continue;
          }
          if (byteLen > 2000) {
            skippedItems.push({ phone: p.formatted, customerName: String(item.customerName || ""), reason: "2,000바이트 초과(" + byteLen + "B)" });
            continue;
          }

          // 단건 연타 중복 방지 (60초 내 동일 번호 + 동일 본문 해시 차단)
          var dupHashKey = "DUP60_" + p.clean + "_" + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, cleanMsg)).slice(0, 12);
          if (cacheSvc.get(dupHashKey)) {
            skippedItems.push({ phone: p.formatted, customerName: String(item.customerName || ""), reason: "1분 내 동일 문자 중복 차단" });
            continue;
          }

          // 송장/방문 발송 시 이미 발송된 건 서버 락 내부 재검증
          var itemSrc = String(item.source || (trackStr ? "delivery" : "manual")).slice(0, 30);
          if (skipAlreadySent) {
            var vMatch = trackStr.match(/^(?:방문\(|VISIT_)(\d{4}-\d{2}-\d{2})\)?$/);
            if (itemSrc === "visit" || vMatch) {
              var vDate = vMatch ? vMatch[1] : todayKstPrefix_();
              if (sentCheck.sentPairMap[p.clean + "|VISIT_" + vDate]) {
                skippedItems.push({ phone: p.formatted, customerName: String(item.customerName || ""), reason: "오늘 이미 발송된 방문문자" });
                continue;
              }
            } else if (trackStr) {
              var firstTrack = trackStr.split(/[,\s/]+/)[0].replace(/\D/g, "");
              if (firstTrack && sentCheck.sentPairMap[p.clean + "|" + firstTrack]) {
                skippedItems.push({ phone: p.formatted, customerName: String(item.customerName || ""), reason: "이미 발송된 송장(" + firstTrack + ")" });
                continue;
              }
            }
          }

          var useRcs = (data.useRcs !== false);
          var rcsBrandId = String(props.getProperty("RCS_BRAND_ID") || DEFAULT_RCS_BRAND_ID_).trim();
          var rcsActive = Boolean(useRcs && rcsBrandId);
          var msgType = rcsActive
            ? (byteLen <= 90 ? "RCS_SMS" : "RCS_LMS")
            : (byteLen <= 90 ? "SMS" : "LMS");
          estimatedCost += (msgType === "SMS" || msgType === "RCS_SMS") ? 18 : 45;

          validBatch.push({
            cleanPhone: p.clean,
            formattedPhone: p.formatted,
            customerName: sanitizeForEucKr_(item.customerName || "").trim(),
            trackingNo: trackStr,
            msgType: msgType,
            byteLen: byteLen,
            message: cleanMsg,
            source: String(item.source || (trackStr ? "delivery" : "manual")).slice(0, 30),
            refId: String(item.refId || "").slice(0, 60),
            dupHashKey: dupHashKey
          });
        }

        if (validBatch.length === 0) {
          return jsonOut_({
            ok: false,
            error: "ALL_SKIPPED",
            message: "발송 가능한 유효 건수가 없습니다. (" + (skippedItems[0] ? skippedItems[0].reason : "중복/오류") + ")",
            skipped: skippedItems
          });
        }

        var apiKey = String(props.getProperty("SOLAPI_API_KEY") || "").trim();
        var apiSecret = String(props.getProperty("SOLAPI_API_SECRET") || "").trim();
        var senderDigits = String(props.getProperty("SENDER_PHONE") || DEFAULT_SENDER_PHONE_).replace(/\D/g, "") || DEFAULT_SENDER_PHONE_;
        var isSimulation = Boolean(data.testMode) || !(apiKey && apiSecret);

        var groupId = "";
        var failedByPhone = {};
        var sentSuccessCount = 0;
        var sentFailCount = 0;
        var balBefore = null;

        if (!isSimulation) {
          // 발송 전 실시간 잔액 확인 (절대 캐시 미사용)
          balBefore = fetchSolapiBalance_(apiKey, apiSecret);
          if (balBefore.availableTotal < estimatedCost) {
            return jsonOut_({
              ok: false,
              error: "INSUFFICIENT_BALANCE",
              message: "솔라피 잔액이 부족합니다. (예상 약 " + estimatedCost + "원 / 현재 사용가능 " + balBefore.availableTotal + "원)",
              balance: balBefore
            });
          }

          var rcsBrandIdSend = String(props.getProperty("RCS_BRAND_ID") || DEFAULT_RCS_BRAND_ID_).trim();
          var solapiMessages = [];
          for (var s = 0; s < validBatch.length; s++) {
            var vb = validBatch[s];
            var msgPayload = {
              to: vb.cleanPhone,
              from: senderDigits,
              type: vb.msgType,
              text: vb.message
            };
            if (vb.msgType === "LMS") {
              msgPayload.subject = "[주누디자인 안내]";
            }
            if ((vb.msgType === "RCS_SMS" || vb.msgType === "RCS_LMS") && rcsBrandIdSend) {
              msgPayload.rcsOptions = {
                brandId: rcsBrandIdSend,
                disableSms: false
              };
            }
            solapiMessages.push(msgPayload);
          }

          var solRes = callSolapiApi_(
            "POST",
            "/messages/v4/send-many/detail",
            {
              messages: solapiMessages,
              allowDuplicates: true
            },
            apiKey,
            apiSecret
          );

          var httpCode = solRes.code;
          var solJson = solRes.parsed || {};

          if (httpCode < 200 || httpCode >= 300) {
            return jsonOut_({
              ok: false,
              error: "SOLAPI_HTTP_" + httpCode,
              message: solJson.errorMessage || solJson.message || ("문자 서버 발송 오류 (HTTP " + httpCode + ")")
            });
          }

          groupId = String(solJson.groupId || (solJson.groupInfo && solJson.groupInfo.groupId) || "");
          var failList = Array.isArray(solJson.failedMessageList) ? solJson.failedMessageList : [];
          for (var f = 0; f < failList.length; f++) {
            var fm = failList[f] || {};
            var fTo = String(fm.to || "").replace(/\D/g, "");
            if (fTo) {
              var fReason = String(fm.statusMessage || fm.reason || fm.statusCode || "발송실패");
              // 같은 번호에 여러 통을 보낸 경우 본문(text)으로 정확히 구분
              if (fm.text) { failedByPhone[fTo + "|" + fm.text] = fReason; failedByPhone["T|" + fTo] = true; }
              else failedByPhone[fTo] = fReason;
            }
          }
        } else {
          groupId = "SIM_" + Date.now();
        }

        // 발송 결과 시트 벌크 저장
        var sentTime = nowKstStr_();
        var logRowsToWrite = [];
        var itemResults = [];
        var actualSuccessCost = 0;

        for (var w = 0; w < validBatch.length; w++) {
          var rowItem = validBatch[w];
          var failReason = failedByPhone["T|" + rowItem.cleanPhone]
            ? (failedByPhone[rowItem.cleanPhone + "|" + rowItem.message] || "")
            : (failedByPhone[rowItem.cleanPhone] || "");
          var statusLabel = "";
          var detailLabel = "";

          if (failReason) {
            statusLabel = "실패";
            detailLabel = failReason;
            sentFailCount++;
          } else if (isSimulation) {
            statusLabel = "체험발송";
            detailLabel = "솔라피 키 연결 전 시뮬레이션 기록";
            sentSuccessCount++;
            try { cacheSvc.put(rowItem.dupHashKey, "1", 60); } catch (ce1) {}
          } else {
            statusLabel = "발송접수";
            detailLabel = "정상 접수 (" + formatSenderDisplay_(senderDigits) + ")";
            sentSuccessCount++;
            actualSuccessCost += ((rowItem.msgType === "SMS" || rowItem.msgType === "RCS_SMS") ? 18 : 45);
            try { cacheSvc.put(rowItem.dupHashKey, "1", 60); } catch (ce2) {}
          }

          var logId = "L" + Date.now() + "_" + (w + 1);
          logRowsToWrite.push([
            logId,
            sentTime,
            safeCell_(rowItem.formattedPhone),
            safeCell_(rowItem.customerName),
            safeCell_(rowItem.trackingNo),
            rowItem.msgType,
            String(rowItem.byteLen),
            safeCell_(rowItem.message),
            statusLabel,
            safeCell_(detailLabel),
            safeCell_(rowItem.source),
            safeCell_(rowItem.refId),
            groupId
          ]);

          itemResults.push({
            phone: rowItem.formattedPhone,
            cleanPhone: rowItem.cleanPhone,
            customerName: rowItem.customerName,
            trackingNo: rowItem.trackingNo,
            msgType: rowItem.msgType,
            status: statusLabel,
            detail: detailLabel
          });
        }

        if (logRowsToWrite.length > 0) {
          var nextLogRow = db.logSheet.getLastRow() + 1;
          db.logSheet.getRange(nextLogRow, 1, logRowsToWrite.length, LOG_HEADERS_.length)
            .setNumberFormat("@")
            .setValues(logRowsToWrite);
        }

        // 실발송 시 표시용 잔액 캐시 무효화 + 성공건만 차감한 추정 잔액 함께 반환 (추가 중계기 왕복 제거)
        var estimatedBalanceObj = null;
        if (!isSimulation) {
          invalidateBalanceCache_(apiKey);
          if (balBefore && typeof balBefore.availableTotal === "number" && isFinite(balBefore.availableTotal)) {
            estimatedBalanceObj = {
              availableTotal: Math.max(0, balBefore.availableTotal - actualSuccessCost),
              estimated: true
            };
          }
        }

        var lightResultObj = {
          ok: true,
          action: "send",
          simulation: isSimulation,
          groupId: groupId,
          successCount: sentSuccessCount,
          failCount: sentFailCount,
          skippedCount: skippedItems.length,
          skipped: skippedItems,
          results: itemResults,
          balance: estimatedBalanceObj
        };

        // REQ_IDEMP_ 캐시에는 대용량 logs(250건)를 제외해 100KB 한도 초과 예외를 원천 차단
        if (requestId) {
          try {
            var idempStr = JSON.stringify(lightResultObj);
            if (idempStr.length < 95000) {
              cacheSvc.put("REQ_IDEMP_" + requestId, idempStr, 21600);
            }
          } catch (idempErr) {}
        }

        var outObj = {
          ok: true,
          action: "send",
          simulation: isSimulation,
          groupId: groupId,
          successCount: sentSuccessCount,
          failCount: sentFailCount,
          skippedCount: skippedItems.length,
          skipped: skippedItems,
          results: itemResults,
          balance: estimatedBalanceObj,
          logs: readRecentLogs_(db.logSheet, 250)
        };

        return ContentService.createTextOutput(JSON.stringify(outObj)).setMimeType(ContentService.MimeType.JSON);
      } finally {
        SpreadsheetApp.flush();
        lockSend.releaseLock();
      }
    }

    return jsonOut_({ ok: false, error: "UNKNOWN_ACTION", message: "지원하지 않는 요청입니다: " + action });
  } catch (fatalErr) {
    return jsonOut_({
      ok: false,
      error: "SERVER_ERROR",
      message: String(fatalErr && fatalErr.message ? fatalErr.message : fatalErr)
    });
  }
}
