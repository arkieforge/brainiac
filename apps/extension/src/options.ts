// The options page: which Brainiac site the extension talks to.
import { originOf, setSite, siteOrigin } from "./site.ts";

const form = document.querySelector<HTMLFormElement>("#site");
const address = document.querySelector<HTMLInputElement>("#address");
const status = document.querySelector<HTMLElement>("#status");

function connected(site: string) {
  if (!status) return;
  const link = document.createElement("a");
  link.href = `${site}/secrets`;
  link.textContent = "your secrets";
  link.target = "_blank";
  status.replaceChildren(`Connected to ${site}. Save portal logins with their domain on `, link, ".");
}

void siteOrigin().then((site) => {
  if (!site) return;
  if (address) address.value = site;
  connected(site);
});

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const origin = originOf(address?.value ?? "");
  if (!origin) {
    status?.replaceChildren("That isn't a site address, like brainiac.example.");
    return;
  }
  // Chrome asks the person to let the extension reach this one site.
  if (await setSite(origin)) connected(origin);
  else status?.replaceChildren("Chrome didn't grant it, so the extension can't reach your record.");
});
