// 2차 인증 OTP 설정값. 인증번호 화면이 바뀌면 이 파일의 셀렉터만 고친다.
export const APPROVAL_CONFIG = {
  hostName: "com.unipost.approval_otp",
  selectors: {
    otpInput: "input.fid-authPass",
    otpSubmit: ".bid-confirm",
  },
  // 값을 넣은 뒤 확인 버튼이 활성화되기를 기다리는 시간
  submitWaitMs: 3000,
};
