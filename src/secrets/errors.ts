import { BetterClawsError } from "../types.js";

export class SecretError extends BetterClawsError {
  constructor(message: string, code: string = "SECRET_ERROR") {
    super(message, "secrets", code);
    this.name = "SecretError";
  }
}
