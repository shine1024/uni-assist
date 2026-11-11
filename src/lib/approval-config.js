// 2차 인증 OTP 설정값. 인증번호 화면이나 메일 제목이 바뀌면 이 파일만 고친다.
export const APPROVAL_CONFIG = {
  selectors: {
    otpInput: "input.fid-authPass",
    otpSubmit: ".bid-confirm",
  },
  // 값을 넣은 뒤 확인 버튼이 활성화되기를 기다리는 시간
  submitWaitMs: 3000,

  // 슬랙 DM 에 올라오는 인증 메일 파일의 제목에 들어 있는 문구
  titleKeyword: "로그인 2차 인증 번호",
  // 메일이 아직 안 왔으면 이 간격으로 다시 확인하고, 이 시간이 지나면 포기한다(인증번호 유효시간 3분)
  pollIntervalMs: 3000,
  waitMs: 180000,
  // 조회를 시작하기 직전에 도착한 메일도 인정하는 범위
  lookbackSec: 180,

  // 자동 입력(설정에서 켰을 때)을 심는 포털 주소
  portalMatches: ["https://unipost.co.kr/portal/*", "http://unipost.co.kr/portal/*"],
};
