// chrome.scripting.executeScript 로 현재 탭에 주입하는 함수.
// 직렬화되어 페이지에서 실행되므로 바깥 변수를 참조하면 안 된다.

/** 인증번호 칸을 채우고 확인 버튼을 누른다. 화면에 보이는 요소만 다룬다. */
export async function pageFillOtp({ inputSelector, submitSelector, code, waitMs }) {
  const visible = (selector) =>
    [...document.querySelectorAll(selector)].filter((element) => element.getClientRects().length > 0);

  const [input] = visible(inputSelector);
  if (!input) return { ok: false, code: "OTP_INPUT_NOT_FOUND" };

  input.focus();
  // React 등은 value 직접 대입을 무시할 수 있어 네이티브 setter 로 넣는다.
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, code);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));

  const deadline = Date.now() + waitMs;
  for (;;) {
    const button = visible(submitSelector).find((element) => !element.disabled);
    if (button) {
      // 페이지가 바로 이동해도 결과를 돌려줄 수 있도록 다음 턴에 누른다.
      setTimeout(() => button.click(), 0);
      return { ok: true };
    }
    if (Date.now() >= deadline) return { ok: false, code: "OTP_SUBMIT_NOT_FOUND" };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
