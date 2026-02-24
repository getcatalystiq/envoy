declare module "sns-validator" {
  class MessageValidator {
    validate(
      message: Record<string, unknown>,
      cb: (err: Error | null) => void,
    ): void;
  }
  export = MessageValidator;
}
