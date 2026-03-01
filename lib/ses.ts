import {
  SESv2Client,
  SendEmailCommand,
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  GetAccountCommand,
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  type SendEmailCommandInput,
} from "@aws-sdk/client-sesv2";
import { getEnv } from "@/lib/env";

let client: SESv2Client | null = null;

function getClient(): SESv2Client {
  if (!client) {
    const env = getEnv();
    client = new SESv2Client({
      region: env.AWS_SES_REGION,
      credentials: {
        accessKeyId: env.SES_ACCESS_KEY_ID,
        secretAccessKey: env.SES_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

export async function sendEmail(opts: {
  toEmail: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  fromEmail?: string;
  replyTo?: string;
  configurationSet?: string;
  tenantName?: string;
  unsubscribeUrl?: string;
}): Promise<Record<string, unknown>> {
  const ses = getClient();
  const fromAddress =
    opts.fromEmail ?? process.env.SES_FROM_EMAIL ?? "noreply@example.com";

  const body: SendEmailCommandInput["Content"] = {
    Simple: {
      Subject: { Data: opts.subject, Charset: "UTF-8" },
      Body: {
        Html: { Data: opts.bodyHtml, Charset: "UTF-8" },
        ...(opts.bodyText
          ? { Text: { Data: opts.bodyText, Charset: "UTF-8" } }
          : {}),
      },
      ...(opts.unsubscribeUrl
        ? {
            Headers: [
              {
                Name: "List-Unsubscribe",
                Value: `<${opts.unsubscribeUrl}>`,
              },
              {
                Name: "List-Unsubscribe-Post",
                Value: "List-Unsubscribe=One-Click",
              },
            ],
          }
        : {}),
    },
  };

  const input: SendEmailCommandInput = {
    FromEmailAddress: fromAddress,
    Destination: { ToAddresses: [opts.toEmail] },
    Content: body,
    ...(opts.replyTo ? { ReplyToAddresses: [opts.replyTo] } : {}),
    ...(opts.configurationSet
      ? { ConfigurationSetName: opts.configurationSet }
      : {}),
  };

  try {
    const response = await ses.send(new SendEmailCommand(input));
    return { success: true, messageId: response.MessageId };
  } catch (err: unknown) {
    const error = err as {
      name?: string;
      message?: string;
      Code?: string;
    };
    return {
      success: false,
      errorCode: error.name ?? "Unknown",
      errorMessage: error.message ?? String(err),
    };
  }
}

export async function sendBulkEmails(
  emails: Array<{
    toEmail: string;
    subject: string;
    bodyHtml: string;
    bodyText?: string;
    fromEmail?: string;
  }>,
  configurationSet?: string,
): Promise<Array<Record<string, unknown>>> {
  const results: Array<Record<string, unknown>> = [];
  for (const email of emails) {
    const result = await sendEmail({
      toEmail: email.toEmail,
      subject: email.subject,
      bodyHtml: email.bodyHtml,
      bodyText: email.bodyText,
      fromEmail: email.fromEmail,
      configurationSet,
    });
    results.push({ ...result, toEmail: email.toEmail });
  }
  return results;
}

export async function verifyDomain(
  domain: string,
): Promise<Record<string, unknown>> {
  const ses = getClient();
  try {
    const response = await ses.send(
      new CreateEmailIdentityCommand({ EmailIdentity: domain }),
    );
    return {
      success: true,
      dkimTokens: response.DkimAttributes?.Tokens ?? [],
      verified: response.VerifiedForSendingStatus ?? false,
    };
  } catch (err: unknown) {
    const error = err as { name?: string; message?: string };
    if (error.name === "AlreadyExistsException") {
      return getDomainVerificationStatus(domain);
    }
    return {
      success: false,
      errorCode: error.name ?? "Unknown",
      errorMessage: error.message ?? String(err),
    };
  }
}

export async function getDomainVerificationStatus(
  domain: string,
): Promise<Record<string, unknown>> {
  const ses = getClient();
  try {
    const response = await ses.send(
      new GetEmailIdentityCommand({ EmailIdentity: domain }),
    );
    return {
      success: true,
      verified: response.VerifiedForSendingStatus ?? false,
      dkimStatus: response.DkimAttributes?.Status,
      dkimTokens: response.DkimAttributes?.Tokens ?? [],
    };
  } catch (err: unknown) {
    const error = err as { name?: string; message?: string };
    return {
      success: false,
      errorCode: error.name ?? "Unknown",
      errorMessage: error.message ?? String(err),
    };
  }
}

export async function getSendQuota(): Promise<Record<string, unknown>> {
  const ses = getClient();
  try {
    const response = await ses.send(new GetAccountCommand({}));
    const quota = response.SendQuota;
    return {
      max24HourSend: quota?.Max24HourSend,
      maxSendRate: quota?.MaxSendRate,
      sentLast24Hours: quota?.SentLast24Hours,
    };
  } catch (err: unknown) {
    return { error: String(err) };
  }
}

export async function createConfigurationSet(
  name: string,
): Promise<Record<string, unknown>> {
  const ses = getClient();
  try {
    await ses.send(
      new CreateConfigurationSetCommand({ ConfigurationSetName: name }),
    );
    return { success: true, configurationSetName: name };
  } catch (err: unknown) {
    const error = err as { name?: string; message?: string };
    if (error.name === "AlreadyExistsException") {
      return {
        success: true,
        configurationSetName: name,
        alreadyExists: true,
      };
    }
    return {
      success: false,
      errorCode: error.name ?? "Unknown",
      errorMessage: error.message ?? String(err),
    };
  }
}

export async function addSnsEventDestination(
  configurationSetName: string,
  snsTopicArn: string,
  eventDestinationName = "sns-events",
): Promise<Record<string, unknown>> {
  const ses = getClient();
  try {
    await ses.send(
      new CreateConfigurationSetEventDestinationCommand({
        ConfigurationSetName: configurationSetName,
        EventDestinationName: eventDestinationName,
        EventDestination: {
          Enabled: true,
          MatchingEventTypes: [
            "SEND",
            "DELIVERY",
            "OPEN",
            "CLICK",
            "BOUNCE",
            "COMPLAINT",
          ],
          SnsDestination: { TopicArn: snsTopicArn },
        },
      }),
    );
    return { success: true };
  } catch (err: unknown) {
    const error = err as { name?: string; message?: string };
    if (error.name === "AlreadyExistsException") {
      return { success: true, alreadyExists: true };
    }
    return {
      success: false,
      errorCode: error.name ?? "Unknown",
      errorMessage: error.message ?? String(err),
    };
  }
}

export async function setupConfigurationSetWithSns(
  name: string,
  snsTopicArn: string,
): Promise<Record<string, unknown>> {
  const result = await createConfigurationSet(name);
  if (!result.success) return result;

  const destResult = await addSnsEventDestination(name, snsTopicArn);
  if (!destResult.success) return destResult;

  return { success: true, configurationSetName: name };
}
