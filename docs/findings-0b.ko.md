# Phase 0b — gzip tail 전략 조사

**한국어** · [English](findings-0b.md)

- 실행 시각: 2026-08-28T14:10:18.248Z
- 대상 조직: `acme`
- 대상: program=12345 environment=987654 (dev)
- 선택: service=`author` name=`aemerror` date=`2026-08-28`

## A. `logs/tail` 링크 조사 ← 이게 되면 (a)/(b) 둘 다 불필요

- tail href: `https://sa012345logshared0a1b2c3d.blob.core.windows.net/log-12345-987654/logs/author_aemerror_2026-08-28.log?<api-version, se, sig, sp, sr, sv>`
- ~~tail 링크 호출 실패: 서명 URL 획득 실패 (404)~~ ← **프로브 버그였다.** 아래 정정 참고.

### 정정 (2026-08-28, 수동 검증)

404 는 권한 문제가 아니라 `resolveSignedUrl()` 이 tail href 를 Cloud Manager 경로로 착각해
`cloudmanager.adobe.io` 에 붙여 요청했기 때문이다. **tail href 는 이미 서명된 스토리지 URL 이다.**

두 링크의 경로를 나란히 놓으면 분명하다:

```
download → /log-12345-987654/logs/gzip/author_aemerror_2026-08-28.log.gz   (gzip)
tail     → /log-12345-987654/logs/author_aemerror_2026-08-28.log           (평문)
```

같은 서명 URL 로 직접 확인한 결과:

```
HTTP/1.1 206 Partial Content
Content-Type:  application/octet-stream
Content-Range: bytes 0-2047/182820103
Accept-Ranges: bytes
첫 3바이트:    32 38 2e   ("28." — 날짜로 시작하는 평문)
aemerror 라인 포맷 일치 ✅   레벨 토큰(*INFO* 등) 확인 ✅
```

### 결론: tail 링크는 **평문이다** ✅

- 평문 크기 **182,820,103 bytes (182MB)** ↔ gzip 8,581,483 bytes. 압축비 약 21:1
- 즉 **하루치 파일을 통째로 받으면 182MB다.** 파일 끝에서 256KB 만 읽는 SPEC 6.3 이
  정확히 이 문제를 위해 설계된 것이다
- gzip 문제는 사라졌다. SPEC 11장의 (a)/(b) 둘 다 필요 없다

버그는 `server/adobe/cloudmanager.ts` 의 `resolveSignedUrl()` 에서 고쳤고,
두 링크 형태를 구분하는 회귀 테스트를 붙였다.

## B. `.gz` 가 멀티멤버인가 ← 되면 SPEC 6.3 이 거의 그대로 산다

- 파일 크기: 8,581,483 bytes
- 꼬리 524,288 bytes 를 받아 멤버 경계를 찾는다.
- 검증된 멤버 시작 오프셋: 0개 

### 결론: **단일 스트림 gzip 이다** ⚠️

꼬리에서 멤버 경계를 찾지 못했다. Range 로 받은 델타만 따로 해제할 수 없다.
A 의 tail 링크가 평문이 아니었다면 SPEC 11장 (a)/(b) 중에서 골라야 한다.

## C. 증가 속도 — 전체 재다운로드(a) 를 골랐을 때의 비용

60초 기다렸다가 다시 잰다.
```
  이전: 8,581,483 bytes
  이후: 8,581,483 bytes
  증가: 0 bytes / 60초
```
- 측정 구간에 파일이 자라지 않았다. 트래픽이 있는 시간대나 환경에서 다시 실행한다.
- `--wait 300000` 으로 대기 시간을 늘려볼 수 있다.

## 결정

- [x] **A 가 평문 → tail 링크로 간다.** SPEC 6.3 을 그대로 쓴다
- [ ] ~~B 가 멀티멤버 → 멤버 단위 해제~~ (단일 스트림이지만 무관해졌다)
- [ ] ~~SPEC 11장 (a)/(b) 중 선택~~ (해당 없음)

### Phase 3 이 따를 규칙

```
tail  링크(평문) → 실시간 tail. Range 폴링. SPEC 6.3 그대로
download 링크(.gz) → 시간대 조회(Phase 4). 하루치를 스트리밍으로 훑을 때만.
                     gunzip 스트림에 흘리면 되고, 부분 해제가 필요 없다
```

주의할 점:

- tail 서명 URL 은 `logs?days=N` 응답 **안에** 들어 있다. 갱신하려면 그 엔드포인트를
  다시 불러야 하고, 그건 Cloud Manager 레이트 리밋을 소모한다.
  다만 TTL 이 24시간이라 하루 한 번이면 된다. **매 폴링마다 부르면 안 된다.**
- Range 폴링 자체는 Azure Blob 으로 직접 나가므로 레이트 리밋과 무관하다. 이 구조를 지킨다.
- UTC 자정 롤오버 시 새 날짜의 tail URL 이 필요하므로 그 시점에 `logs?days=1` 을 다시 부른다.
- 파일이 182MB 다. 최초 진입에 `TAIL_INITIAL_BYTES`(256KB) 만 읽는 규칙을 반드시 지킨다.

## C 재측정

dev 환경이라 60초 동안 파일이 자라지 않았다. 반영 지연(SPEC Phase 0 의 4번)은
아직 미측정이다. tail URL 이 평문이므로 이제 Phase 0 프로브로 잴 수 있다 —
트래픽이 있는 시간대에 다시 돌린다. 폴링 주기 5초는 그때까지 기본값으로 둔다.
