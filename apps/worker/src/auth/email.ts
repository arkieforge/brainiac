/** How auth sends mail. The Worker backs it with Cloudflare Email Service; tests capture it. */
export type Mailer = (message: { to: string; subject: string; text: string }) => Promise<void>;

export const otpEmail = (to: string, otp: string) => ({
  to,
  subject: `Your Brainiac code: ${otp}`,
  text: `Your Brainiac code is ${otp}. It expires in 5 minutes.\n\nIf you didn't ask for it, you can ignore this email.`,
});

export const recoveryNotice = (to: string, approvesAt: Date, accountURL: string) => ({
  to,
  subject: "A new passkey was added to your Brainiac account",
  text: [
    "A passkey was added to your Brainiac account without confirming with one of your passkeys first.",
    `It can approve changes from ${approvesAt.toUTCString()}. Until then it can sign in but approve nothing.`,
    "If you added it, there's nothing to do.",
    `If you didn't, sign in with a passkey you already have and remove it before then: ${accountURL}`,
  ].join("\n\n"),
});
