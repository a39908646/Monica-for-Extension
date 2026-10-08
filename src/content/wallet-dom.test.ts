import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { fillWallet, scanWalletKinds } from "./wallet-dom";

function page(html: string) {
  const dom = new JSDOM(html, { url: "https://checkout.example.com", pretendToBeVisual: true });
  for (const control of Array.from(dom.window.document.querySelectorAll<HTMLElement>("input,select,textarea"))) {
    control.getBoundingClientRect = () => ({ x: 0, y: 0, width: 220, height: 40, top: 0, right: 220, bottom: 40, left: 0, toJSON: () => ({}) });
  }
  return dom;
}

function show(control: HTMLElement): void {
  control.getBoundingClientRect = () => ({ x: 0, y: 0, width: 220, height: 40, top: 0, right: 220, bottom: 40, left: 0, toJSON: () => ({}) });
}

describe("wallet DOM filling", () => {
  it("discovers and fills standard identity and address autocomplete fields", () => {
    const dom = page('<input autocomplete="given-name"><input autocomplete="family-name"><input autocomplete="street-address"><input autocomplete="postal-code">');
    expect(scanWalletKinds(dom.window.document)).toEqual(["identity", "billing-address"]);
    expect(fillWallet({ kind: "identity", fields: { firstName: "Joy", lastName: "Lin", streetAddress: "1 Monica Road", postalCode: "200000" } }, dom.window.document)).toMatchObject({ ok: true, filledCount: 4 });
    expect(Array.from(dom.window.document.querySelectorAll<HTMLInputElement>("input")).map((input) => input.value)).toEqual(["Joy", "Lin", "1 Monica Road", "200000"]);
  });

  it("fills card fields only after an explicit card payload", () => {
    const dom = page('<input autocomplete="cc-name"><input autocomplete="cc-number"><input autocomplete="cc-exp"><input autocomplete="cc-csc">');
    expect(scanWalletKinds(dom.window.document)).toContain("card");
    expect(fillWallet({ kind: "card", fields: { cardholderName: "Joy Lin", cardNumber: "4111111111111111", cardExpiry: "12/30", cardSecurityCode: "123" } }, dom.window.document)).toMatchObject({ ok: true, filledCount: 4 });
  });

  it("uses conservative exact heuristics for document and bank account fields", () => {
    const dom = page('<label>Passport number<input name="passport_number"></label><input name="iban"><input name="routing_number">');
    expect(scanWalletKinds(dom.window.document)).toEqual(["identity", "card", "payment-account"]);
    expect(fillWallet({ kind: "payment-account", fields: { iban: "DE89370400440532013000", routingNumber: "021000021" } }, dom.window.document)).toMatchObject({ ok: true, filledCount: 2 });
  });

  it("fills document-specific fields only from explicit labels", () => {
    const dom = page('<input name="passport_number"><input name="document_expiry_date"><input name="issuing_authority"><input name="license_number"><input name="ssn">');
    expect(fillWallet({ kind: "identity", fields: { passportNumber: "P123", documentExpiryDate: "2030-01-01", documentIssuedBy: "Monica Authority", licenseNumber: "DL9", ssn: "SS1" } }, dom.window.document)).toMatchObject({ ok: true, filledCount: 5 });
  });

  it("fills card banking fields only from explicit international labels", () => {
    const dom = page('<input name="card_pin"><input name="bank_account_number"><input name="routing_number"><input name="iban"><input name="swift_bic"><input name="branch_code"><input name="currency"><input name="pin">');
    expect(fillWallet({ kind: "card", fields: { cardPin: "7890", paymentAccountNumber: "0042", routingNumber: "021000021", iban: "DE89", swiftBic: "BICCODE", branchCode: "001", currency: "EUR" } }, dom.window.document)).toMatchObject({ ok: true, filledCount: 7 });
    expect(dom.window.document.querySelector<HTMLInputElement>('input[name="pin"]')!.value).toBe("");
  });

  it("does not guess generic number code or password fields", () => {
    const dom = page('<label>号码<input name="number"></label><label>验证码<input name="code"></label><input name="pin"><input name="secret" type="password">');
    expect(scanWalletKinds(dom.window.document)).toEqual([]);
    expect(fillWallet({ kind: "card", fields: { cardNumber: "4111111111111111", cardSecurityCode: "123" } }, dom.window.document)).toMatchObject({ ok: false, filledCount: 0 });
  });

  it("does not treat a login form's account field as identity, address or payment data", () => {
    const dom = page('<form id="login_form"><input id="email" autocomplete="email"><input id="passwd" type="password"><button type="submit">登录</button></form>');
    // 登录表单的邮箱框带着 autocomplete="email"：以前会被当成证件/地址/支付字段，
    // 导致任何登录页都在弹窗里显示无关的「证件与支付方式」。
    expect(scanWalletKinds(dom.window.document)).toEqual([]);
    expect(fillWallet({ kind: "identity", fields: { email: "joy@example.com" } }, dom.window.document)).toMatchObject({ ok: false, filledCount: 0 });
    expect(dom.window.document.querySelector<HTMLInputElement>("#email")!.value).toBe("");
  });

  it("keeps scanning identity fields on a form without a password", () => {
    const dom = page('<form id="profile"><input id="email" autocomplete="email"><input id="phone" autocomplete="tel"></form>');
    expect(scanWalletKinds(dom.window.document)).toEqual(["identity", "billing-address", "payment-account"]);
    expect(fillWallet({ kind: "identity", fields: { email: "joy@example.com", phone: "13800000000" } }, dom.window.document)).toMatchObject({ ok: true, filledCount: 2 });
  });

  it("excludes only the login form when the page also carries a wallet form", () => {
    const dom = page('<form id="login"><input id="email" autocomplete="email"><input id="passwd" type="password"></form><form id="identity"><input id="full_name" autocomplete="name"><input id="contact_email" autocomplete="email"></form>');
    expect(scanWalletKinds(dom.window.document)).toEqual(["identity", "billing-address", "payment-account"]);
    expect(fillWallet({ kind: "identity", fields: { fullName: "Joy Lin", email: "joy@example.com" } }, dom.window.document)).toMatchObject({ ok: true, filledCount: 2 });
    expect(dom.window.document.querySelector<HTMLInputElement>("#email")!.value).toBe("");
    expect(dom.window.document.querySelector<HTMLInputElement>("#full_name")!.value).toBe("Joy Lin");
    expect(dom.window.document.querySelector<HTMLInputElement>("#contact_email")!.value).toBe("joy@example.com");
  });

  it("recognizes Android-derived Chinese card labels", () => {
    const dom = page('<label>持卡人姓名<input></label><label>银行卡号<input></label><label>信用卡有效期<input></label><label>信用卡安全码<input></label>');
    expect(scanWalletKinds(dom.window.document)).toEqual(["card"]);
    expect(fillWallet({ kind: "card", fields: { cardholderName: "Joy Lin", cardNumber: "4111111111111111", cardExpiry: "12/30", cardSecurityCode: "123" } }, dom.window.document)).toMatchObject({ ok: true, filledCount: 4 });
  });

  it("recognizes Chinese identity and address labels", () => {
    const dom = page('<label>姓<input></label><label>名<input></label><label>身份证号码<input></label><label>出生日期<input></label><label>详细地址<input></label><label>省份<input></label><label>城市<input></label><label>邮政编码<input></label><label>国家或地区<input></label><label>手机号码<input></label><label>电子邮箱<input></label>');
    expect(scanWalletKinds(dom.window.document)).toEqual(["identity", "billing-address", "payment-account"]);
    expect(fillWallet({ kind: "identity", fields: { firstName: "Joy", lastName: "Lin", documentNumber: "310000000000000000", birthDate: "2000-01-01", streetAddress: "Monica 路 1 号", stateProvince: "上海", city: "上海", postalCode: "200000", country: "中国", phone: "13800000000", email: "joy@example.com" } }, dom.window.document)).toMatchObject({ ok: true, filledCount: 11 });
  });

  it("allows an identity record to fill organization fields", () => {
    const dom = page('<label>公司名称<input name="organization"></label>');
    expect(scanWalletKinds(dom.window.document)).toContain("identity");
    expect(fillWallet({ kind: "identity", fields: { company: "Monica Labs" } }, dom.window.document)).toMatchObject({ ok: true, filledCount: 1 });
    expect(dom.window.document.querySelector<HTMLInputElement>('input[name="organization"]')!.value).toBe("Monica Labs");
  });

  it("recognizes Chinese and legacy bank-account labels", () => {
    const dom = page('<label>银行名称<input></label><label>账户名称<input></label><label>账户持有人<input></label><label>银行账号<input></label><label>路由号码<input></label><label>国际银行账号<input></label><label>SWIFT代码<input></label><label>币种<input></label>');
    expect(scanWalletKinds(dom.window.document)).toEqual(["card", "payment-account"]);
    expect(fillWallet({ kind: "payment-account", fields: { paymentProvider: "Example Bank", paymentAccountName: "Daily", paymentAccountHolder: "Joy Lin", paymentAccountNumber: "0042", routingNumber: "021000021", iban: "DE89370400440532013000", swiftBic: "EXAMPLEBIC", currency: "CNY" } }, dom.window.document)).toMatchObject({ ok: true, filledCount: 8 });
  });

  it("discovers and fills wallet controls in nested open shadow roots", () => {
    const dom = page('<payment-shell id="payment"></payment-shell>');
    const outer = dom.window.document.querySelector("#payment")!.attachShadow({ mode: "open" });
    const innerHost = dom.window.document.createElement("section");
    outer.append(innerHost);
    const inner = innerHost.attachShadow({ mode: "open" });
    inner.innerHTML = '<input id="number" autocomplete="cc-number"><input id="csc" autocomplete="cc-csc"><input id="generic" name="number">';
    for (const control of Array.from(inner.querySelectorAll<HTMLElement>("input"))) show(control);

    expect(scanWalletKinds(dom.window.document)).toEqual(["card"]);
    expect(fillWallet({ kind: "card", fields: { cardNumber: "4111111111111111", cardSecurityCode: "123" } }, dom.window.document)).toMatchObject({ ok: true, filledCount: 2 });
    expect(inner.querySelector<HTMLInputElement>("#number")!.value).toBe("4111111111111111");
    expect(inner.querySelector<HTMLInputElement>("#csc")!.value).toBe("123");
    expect(inner.querySelector<HTMLInputElement>("#generic")!.value).toBe("");
  });
});
