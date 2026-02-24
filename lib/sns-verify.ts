import MessageValidator from "sns-validator";

const validator = new MessageValidator();

export async function verifySnsMessage(
  body: string,
): Promise<Record<string, unknown>> {
  const message = JSON.parse(body);
  return new Promise((resolve, reject) => {
    validator.validate(message, (err: Error | null) => {
      if (err) reject(err);
      else resolve(message);
    });
  });
}

export async function handleSnsSubscriptionConfirmation(
  message: Record<string, unknown>,
): Promise<void> {
  const subscribeUrl = message.SubscribeURL as string | undefined;
  if (!subscribeUrl) {
    throw new Error("No SubscribeURL in SNS subscription confirmation message");
  }
  const response = await fetch(subscribeUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to confirm SNS subscription: HTTP ${response.status}`,
    );
  }
}
