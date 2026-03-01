import crypto from "crypto";

const HOST_PATTERN = /^sns\.[a-zA-Z0-9-]{3,}\.amazonaws\.com(\.cn)?$/;

const REQUIRED_KEYS = [
  "Message",
  "MessageId",
  "Timestamp",
  "TopicArn",
  "Type",
  "Signature",
  "SigningCertURL",
  "SignatureVersion",
];

const SUBSCRIPTION_CONTROL_KEYS = ["SubscribeURL", "Token"];

const SIGNABLE_KEYS_NOTIFICATION = [
  "Message",
  "MessageId",
  "Subject",
  "SubscribeURL",
  "Timestamp",
  "TopicArn",
  "Type",
];

const SIGNABLE_KEYS_SUBSCRIPTION = [
  "Message",
  "MessageId",
  "Subject",
  "SubscribeURL",
  "Timestamp",
  "Token",
  "TopicArn",
  "Type",
];

const LAMBDA_KEY_MAP: Record<string, string> = {
  SigningCertUrl: "SigningCertURL",
  UnsubscribeUrl: "UnsubscribeURL",
};

const certCache = new Map<string, string>();

function normalizeLambdaKeys(
  message: Record<string, unknown>,
): Record<string, unknown> {
  for (const [from, to] of Object.entries(LAMBDA_KEY_MAP)) {
    if (from in message) {
      message[to] = message[from];
    }
  }
  if ("Subject" in message && message.Subject === null) {
    delete message.Subject;
  }
  return message;
}

function hasKeys(obj: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => key in obj);
}

function validateMessageStructure(message: Record<string, unknown>): boolean {
  if (!hasKeys(message, REQUIRED_KEYS)) return false;

  const type = message.Type as string;
  if (
    type === "SubscriptionConfirmation" ||
    type === "UnsubscribeConfirmation"
  ) {
    return hasKeys(message, SUBSCRIPTION_CONTROL_KEYS);
  }

  return true;
}

function validateCertUrl(certUrl: string): boolean {
  try {
    const parsed = new URL(certUrl);
    return (
      parsed.protocol === "https:" &&
      parsed.pathname.endsWith(".pem") &&
      HOST_PATTERN.test(parsed.host)
    );
  } catch {
    return false;
  }
}

async function fetchCertificate(certUrl: string): Promise<string> {
  const cached = certCache.get(certUrl);
  if (cached) return cached;

  const response = await fetch(certUrl);
  if (!response.ok) {
    throw new Error("Certificate could not be retrieved");
  }

  const pem = await response.text();
  certCache.set(certUrl, pem);
  return pem;
}

async function verifySignature(
  message: Record<string, unknown>,
): Promise<void> {
  const signatureVersion = message.SignatureVersion as string;
  if (signatureVersion !== "1" && signatureVersion !== "2") {
    throw new Error(
      `The signature version ${signatureVersion} is not supported.`,
    );
  }

  const algorithm =
    signatureVersion === "1" ? "RSA-SHA1" : "RSA-SHA256";
  const signableKeys =
    message.Type === "SubscriptionConfirmation"
      ? SIGNABLE_KEYS_SUBSCRIPTION
      : SIGNABLE_KEYS_NOTIFICATION;

  const verifier = crypto.createVerify(algorithm);
  for (const key of signableKeys) {
    if (key in message) {
      verifier.update(`${key}\n${message[key]}\n`, "utf8");
    }
  }

  const certificate = await fetchCertificate(
    message.SigningCertURL as string,
  );

  if (!verifier.verify(certificate, message.Signature as string, "base64")) {
    throw new Error("The message signature is invalid.");
  }
}

export async function verifySnsMessage(
  body: string,
): Promise<Record<string, unknown>> {
  const message = normalizeLambdaKeys(JSON.parse(body));

  if (!validateMessageStructure(message)) {
    throw new Error("Message missing required keys.");
  }

  if (!validateCertUrl(message.SigningCertURL as string)) {
    throw new Error("The certificate is located on an invalid domain.");
  }

  await verifySignature(message);

  return message;
}

export async function handleSnsSubscriptionConfirmation(
  message: Record<string, unknown>,
): Promise<void> {
  const subscribeUrl = message.SubscribeURL as string | undefined;
  if (!subscribeUrl) {
    throw new Error(
      "No SubscribeURL in SNS subscription confirmation message",
    );
  }
  const response = await fetch(subscribeUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to confirm SNS subscription: HTTP ${response.status}`,
    );
  }
}
