import type { FastifyInstance } from 'fastify';

/**
 * `Content-Type: application/json` 인데 본문이 빈 요청을 통과시킨다.
 *
 * Fastify 기본값은 여기서 400(FST_ERR_CTP_EMPTY_JSON_BODY) 으로 끊는다. 그런데
 * 본문 파싱은 인증 훅보다 **앞**이라, 세션이 멀쩡해도 라우트에 닿지 못하고
 * 오류 코드는 'request_error' 로 뭉개져 나간다 — 왜 거절당했는지 알 길이 없다.
 *
 * 실제로 화면의 fetch 래퍼가 본문 유무와 상관없이 이 헤더를 붙이는 바람에
 * 본문 없는 호출이 통째로 막혀 있었다 — 로그아웃, 조회 취소, 비밀번호 초기화,
 * 세션 회수, 계정·알림규칙·저장필터 삭제. 로그아웃이 '눌러도 아무 일도
 * 안 일어나는' 증상으로 먼저 드러났다.
 *
 * 래퍼는 고쳤지만(web/src/api/client.ts) 같은 함정을 서버에서도 닫아둔다.
 * 본문이 필요한 라우트는 어차피 zod 로 검증하므로, 비어 있으면 '무엇이 빠졌는지'
 * 말해주는 쪽이 낫다.
 */
export function registerJsonBodyParser(app: FastifyInstance): void {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = (body as string).trim();
    if (text === '') return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(Object.assign(new Error('invalid json'), { statusCode: 400 }), undefined);
    }
  });
}
