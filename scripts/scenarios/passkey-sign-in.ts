import type { Scenario } from "./scenario.ts";

// A new account adds its first passkey, which can approve at once, then signs out and back in with it. Chrome's
// virtual authenticator stands in for a phone or security key, so the ceremonies are the real ones.
export default {
  empty: true,
  steps: [
    {
      name: "dev sign-in lands on the account page",
      run: async (page, { email }) => {
        await page.waitForURL(/\/account$/);
        await page.getByText(`Signed in as ${email}`).waitFor();
      },
    },
    {
      name: "first passkey enrolls and can approve",
      run: async (page) => {
        await page.locator("#add").click();
        await page.getByText("Can approve", { exact: true }).waitFor();
      },
    },
    {
      name: "sign out returns to sign-in",
      run: async (page) => {
        await page.locator("#sign-out").click();
        await page.waitForURL(/\/sign-in$/);
      },
    },
    {
      name: "passkey signs back in",
      run: async (page, { email }) => {
        await page.locator("#passkey").click();
        await page.waitForURL(/\/account$/);
        await page.getByText(`Signed in as ${email}`).waitFor();
      },
    },
  ],
} satisfies Scenario;
