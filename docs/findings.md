# Phase 0 검증 결과

- 실행 시각: 2026-08-28T14:53:41.844Z
- 대상 조직: `acme` (ACME 코퍼레이션)
- 표본 수: 8, 폴링 간격: 5000ms

## 0. IMS 토큰

- OK. 발급 소요 285ms (토큰 값은 기록하지 않는다)
- 프로그램 1개: 12345(Example-Program)
- 환경 4개: 987654(example-dev/dev), 987655(example-rde/rde), 987656(example-stage/stage), 987657(example-prod/prod)
- 대상: program=12345 environment=987654 (dev)

## 5. `logs?days=1` 응답 스키마 실물

```json
{
  "_links": {
    "http://ns.adobe.com/adobecloud/rel/program": {
      "href": "string",
      "templated": "boolean"
    },
    "self": {
      "href": "string",
      "templated": "boolean"
    }
  },
  "_embedded": {
    "downloads": [
      {
        "_links": {
          "http://ns.adobe.com/adobecloud/rel/logs/download": "…",
          "http://ns.adobe.com/adobecloud/rel/logs/tail": "…"
        },
        "service": "string",
        "name": "string",
        "date": "string",
        "programId": "number",
        "environmentId": "number"
      },
      "…(32건)"
    ]
  },
  "service": [],
  "name": [],
  "days": "number"
}
```

파싱된 옵션:
```
  service=author name=aemaccess date=2026-08-28
  service=author name=aemaccess date=2026-08-27
  service=author name=aemerror date=2026-08-28
  service=author name=aemerror date=2026-08-27
  service=author name=aemrequest date=2026-08-28
  service=author name=aemrequest date=2026-08-27
  service=author name=cdn date=2026-08-28
  service=author name=cdn date=2026-08-27
  service=dispatcher name=aemdispatcher date=2026-08-28
  service=dispatcher name=aemdispatcher date=2026-08-27
  service=dispatcher name=httpdaccess date=2026-08-28
  service=dispatcher name=httpdaccess date=2026-08-27
  service=dispatcher name=httpderror date=2026-08-28
  service=dispatcher name=httpderror date=2026-08-27
  service=preview_dispatcher name=aemdispatcher date=2026-08-28
  service=preview_dispatcher name=aemdispatcher date=2026-08-27
  service=preview_dispatcher name=httpdaccess date=2026-08-28
  service=preview_dispatcher name=httpdaccess date=2026-08-27
  service=preview_dispatcher name=httpderror date=2026-08-28
  service=preview_dispatcher name=httpderror date=2026-08-27
  service=preview_publish name=aemaccess date=2026-08-28
  service=preview_publish name=aemaccess date=2026-08-27
  service=preview_publish name=aemerror date=2026-08-28
  service=preview_publish name=aemerror date=2026-08-27
  service=preview_publish name=aemrequest date=2026-08-28
  service=preview_publish name=aemrequest date=2026-08-27
  service=publish name=aemaccess date=2026-08-28
  service=publish name=aemaccess date=2026-08-27
  service=publish name=aemerror date=2026-08-28
  service=publish name=aemerror date=2026-08-27
  service=publish name=aemrequest date=2026-08-28
  service=publish name=aemrequest date=2026-08-27
```

선택: service=`author` name=`aemerror` date=`2026-08-28`

## 1. 302 Location 서명 URL 의 만료 시간

- URL 형태: `https://sa012345logshared0a1b2c3d.blob.core.windows.net/log-12345-987654/logs/gzip/author_aemerror_2026-08-28.log.gz?<api-version, se, sig, sp, sr, sv>`
- 만료: 2026-08-29T14:53:50.000Z → 발급 시점 기준 **약 86400초 (1440.0분)**
- → 재발급 임계값은 이 값의 80% 지점을 쓴다.

## 2. 당일 파일이 gzip 인가 평문인가 ← 핵심

`logs?days=N` 응답에는 링크가 둘 있고 가리키는 파일이 다르다. 둘 다 본다.

- download: `https://sa012345logshared0a1b2c3d.blob.core.windows.net/log-12345-987654/logs/gzip/author_aemerror_2026-08-28.log.gz?<api-version, se, sig, sp, sr, sv>`
- tail:     `https://sa012345logshared0a1b2c3d.blob.core.windows.net/log-12345-987654/logs/author_aemerror_2026-08-28.log?<api-version, se, sig, sp, sr, sv>`

- HTTP 206
- `Content-Type`: application/octet-stream
- `Content-Encoding`: (없음)
- `Content-Range`: bytes 0-1023/8584150  → 전체 크기 8,584,150 bytes
- 첫 2바이트: 1f 8b ← gzip 매직(1f 8b)

### download 링크는 **gzip 이다**

이 파일은 Range 로 부분 디코딩이 안 되므로 실시간 tail 에 쓰지 않는다.
하루치를 통째로 스트리밍하는 Phase 4 의 시간대 조회 전용이다.
실시간 tail 은 아래 2b 의 평문 파일을 쓴다.

## 2b. tail 링크 — 실시간 tail 이 실제로 쓰는 파일

- HTTP 206, `Accept-Ranges`: bytes
- 첫 3바이트: 32 38 2e 
- 전체 크기: **183,247,656 bytes** (압축본 8,584,150 bytes 대비 21.3배)

### 평문이다 ✅ SPEC 6.3 을 그대로 쓴다

## 3. 서명 URL 의 Range 지원

- `Range: bytes=0-1023` → HTTP **206** (206 Partial Content — 지원)
- `Accept-Ranges`: bytes
- 꼬리 `Range: bytes=8580054-` → HTTP **206**, 4096 bytes 수신
- 파일 끝 너머 `Range: bytes=8584150-` → HTTP **416** (416 — 새 데이터 없음 판정에 쓸 수 있다)

## 4. 새 로그 반영 지연

평문 tail 파일의 끝을 5000ms 간격으로 8회 읽어, 새로 나타난 마지막 라인의 타임스탬프와 관측 시각의 차이를 잰다.

```
  표본 1: 새 라인 없음
  표본 2: 새 라인 없음
  표본 3: 새 라인 없음
  표본 4: 새 라인 없음
  표본 5: 122.2초
  표본 6: 새 라인 없음
  표본 7: 새 라인 없음
  표본 8: 새 라인 없음
```
- **중앙값 122.2초** (표본 1/8)
- → 폴링 주기 5000ms 는 지연에 비해 과하다. 늘려도 된다.

## 결정이 필요한 사항


- [x] tail 전략: `logs/tail` 의 평문 파일에 Range 폴링 (Phase 0b 에서 확정)
- [ ] 4번의 반영 지연 중앙값에 맞춰 `TAIL_POLL_INTERVAL_MS` 조정

---

# 실트래픽 측정 (2026-08-28, dev / author / aemerror)

트래픽을 흘리면서 잰 값이다. 이 셋이 `TAIL_POLL_INTERVAL_MS` 를 정했다.

## 1. 파서가 실환경에서 맞는가 → **맞는다**

꼬리 177줄을 SPEC 정규식에 넣었다.

```
SPEC 정규식 일치: 177/177 (100.0%)
파서 레벨 분포: { INFO: 148, WARN: 28, ERROR: 1 }
UNKNOWN 비율: 0.0%
```

SPEC 6.4 의 정규식이 실물과 정확히 맞는다. 파서는 고칠 게 없다.

## 2. flush 주기 → **약 60초**

3초 간격으로 4분간 파일 크기를 감시했다.

```
  + 12초    3,116 bytes
  + 70초   42,386 bytes
  +131초      232 bytes

총 폴링 79회 중 데이터가 온 건 3회 (4%)
flush 간격: 최소 58초 / 중앙값 61초 / 최대 61초
flush 당 평균 15,245 bytes
```

로그는 연속으로 흐르지 않는다. **약 60초마다 몰아서 blob 에 쓰인다.**
간격이 58~61초로 매우 규칙적이다.

## 3. 반영 지연 → **약 120초**

파일에 있는 가장 최근 엔트리의 시각과 관측 시각의 차이:

```
가장 최근 엔트리: 2026-08-28T14:53:14.107Z
관측 시각:        2026-08-28T14:55:20.714Z
차이: 126.6초
```

프로브의 표본 측정에서도 122.2초가 나왔다. 두 방법이 일치한다.

**이건 Adobe 쪽 파이프라인 지연이라 폴링을 아무리 자주 해도 줄지 않는다.**

## 결정: `TAIL_POLL_INTERVAL_MS` 5000 → **20000**

- flush 가 60초 주기이므로 5초 폴링은 12번 중 11번이 416 이다
- 20초면 flush 당 3회 확인한다. 감지 지연은 평균 10초 늘어나는데,
  이미 120초 밀려 있는 값에 10초를 더하는 것이라 체감 차이가 없다
- 요청 수는 4분의 1로 준다

폴링은 Azure Blob 으로 직접 나가므로 Cloud Manager 레이트 리밋과는 무관하다.
그래도 헛걸음을 12배 할 이유는 없다.

## UI 에 반영한 것

파이프라인 지연이 2분이라 방금 만든 에러가 화면에 없는 게 정상이다.
그걸 모르면 도구가 고장난 줄 안다. 툴바에 **"최신 N초 전"** 을 띄우고,
3분을 넘으면 노란색으로 바꿔 트래픽이 끊겼거나 파이프라인이 밀렸음을 알린다.

## 아직 안 본 것

- `preview_publish`, `publish` 는 이번 측정 구간에 트래픽이 없었다 (증가 0).
  author 와 다른 특성이 있는지는 미확인.
- Additional Publish Region 환경은 여전히 미확인.

## 4. TailSession 을 실환경에 대고 돌린 결과

프로덕션 코드 경로 그대로다.

```
start() 4533ms — 183MB 파일에서 256KB 만 읽었다 (offset 183,749,357)
버퍼: 754건
레벨 분포: { INFO: 646, WARN: 103, ERROR: 4, UNKNOWN: 1 }
UNKNOWN: 1건 (0.1%)   ← 중간부터 읽어 첫 줄이 잘린 것. 정상
스택트레이스가 묶인 엔트리: 2건 (가장 긴 것 7줄)
마스킹된 엔트리: 11건
가장 최근 엔트리: 173초 전

폴링 1 (20초 후): +0건, offset 그대로      ← flush 사이 구간
폴링 2 (20초 후): +3건, +759 bytes         ← flush 도착
stop() 후 버퍼: 0건
```

60초 flush 주기가 폴링 결과에 그대로 나타난다.

## 5. 마스킹 오탐 — 실데이터에서 하나 잡혔다

1,134줄에 규칙을 걸어봤다.

| 규칙 | 적중 | 판정 |
|---|---|---|
| `email` | 11줄 (1.0%) | 정상. `y***@example.com` — 실제 이메일이다 |
| `credit-card` | 1줄 (0.1%) | **오탐** |

오탐 내용:

```
"type":"KEY_PHRASE","confidence":0.****-****-****-3973
```

`"confidence":0.1234567890139730` 의 **소수부가 Luhn 을 통과해** 카드번호로 가려졌다.
`\b` 는 소수점 뒤에서 경계가 서기 때문에 소수부가 독립된 숫자열로 잡힌다.

합성 테스트에는 JSON 소수가 없어서 못 잡았다. 실데이터를 넣어보고서야 나왔다.

**고침**: 카드·주민번호 규칙 모두 앞뒤에 숫자·소수점·쉼표가 붙으면 건너뛰도록 했다
(`(?<![\d.,])` / `(?![\d.,])`). 회귀 테스트 3건을 붙였고, 수정 후 재측정에서 오탐은 사라지고
이메일 11건만 남았다.
