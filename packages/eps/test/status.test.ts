import { expect, it } from "vitest";
import { normalizeEpsStatus, readVerifyResponse } from "../status";

it("normalizes the aliases, case-insensitively", () => {
  for (const s of ["Success", "SUCCESS", "success", "COMPLETED", "completed"])
    expect(normalizeEpsStatus(s), s).toBe("success");
  for (const s of ["Failed", "FAILURE", "failure"]) expect(normalizeEpsStatus(s), s).toBe("failed");
  for (const s of ["CANCEL", "Canceled", "CANCELED", "cancelled"])
    expect(normalizeEpsStatus(s), s).toBe("cancelled");
  expect(normalizeEpsStatus("Pending")).toBe("pending");
});

it("gives unknown for everything else, including non-strings", () => {
  for (const s of ["", " ", "Done", "OK", "SUCCESSFUL", " Success"])
    expect(normalizeEpsStatus(s), s).toBe("unknown");
  for (const s of [1, null, undefined, {}, [], true]) expect(normalizeEpsStatus(s)).toBe("unknown");
});

it("reads the field names of the skill", () => {
  const r = readVerifyResponse({
    Status: "Success",
    MerchantTransactionId: "TCP" + "a".repeat(32),
    EpsTransactionId: "E1",
    TotalAmount: "1500.00",
  });
  expect(r).toEqual({
    status: "success",
    merchantTransactionId: "TCP" + "a".repeat(32),
    epsTransactionId: "E1",
    totalAmountMinor: 150000n,
    errorCode: null,
  });
});

it("reads every status alias position and the second spelling of the eps id", () => {
  expect(readVerifyResponse({ transactionStatus: "COMPLETED" }).status).toBe("success");
  expect(readVerifyResponse({ status: "Failed" }).status).toBe("failed");
  expect(readVerifyResponse({ data: { transactionStatus: "PENDING" } }).status).toBe("pending");
  expect(readVerifyResponse({ data: { status: "CANCELED" } }).status).toBe("cancelled");
  expect(readVerifyResponse({ EPSTransactionId: "E2" }).epsTransactionId).toBe("E2");
});

it("takes the first non-empty string status and skips empty or non-string ones", () => {
  expect(readVerifyResponse({ Status: "", transactionStatus: "Success" }).status).toBe("success");
  expect(readVerifyResponse({ Status: 5, status: "Failed" }).status).toBe("failed");
});

it("gives unknown when two status fields disagree after normalising", () => {
  expect(readVerifyResponse({ Status: "Success", transactionStatus: "Failed" }).status).toBe(
    "unknown",
  );
  expect(readVerifyResponse({ Status: "Success", data: { status: "COMPLETED" } }).status).toBe(
    "success",
  );
});

it("never throws and returns unknown with nulls for a malformed body", () => {
  const empty = {
    status: "unknown",
    merchantTransactionId: null,
    epsTransactionId: null,
    totalAmountMinor: null,
    errorCode: null,
  };
  for (const body of [null, undefined, "text", 5, [], ["Status"], true])
    expect(readVerifyResponse(body)).toEqual(empty);
  expect(readVerifyResponse({ data: null }).status).toBe("unknown");
  expect(readVerifyResponse({ data: "x" }).status).toBe("unknown");
});

it("gives a null amount for a number or a bad text", () => {
  expect(readVerifyResponse({ Status: "Success", TotalAmount: 1500 }).totalAmountMinor).toBeNull();
  expect(
    readVerifyResponse({ Status: "Success", TotalAmount: "1,500.00" }).totalAmountMinor,
  ).toBeNull();
  expect(readVerifyResponse({ Status: "Success" }).totalAmountMinor).toBeNull();
});

it("reads the error code as text only", () => {
  expect(readVerifyResponse({ ErrorCode: "E42" }).errorCode).toBe("E42");
  expect(readVerifyResponse({ ErrorCode: 42 }).errorCode).toBeNull();
});
