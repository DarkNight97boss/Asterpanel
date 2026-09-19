/** ISO 3166-1 alpha-2 codes; names come from Intl so they follow the site language. */
export const COUNTRY_CODES = "AD AE AF AG AI AL AM AO AR AT AU AW AZ BA BB BD BE BF BG BH BI BJ BM BN BO BR BS BT BW BY BZ CA CD CG CH CI CL CM CN CO CR CU CV CW CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FO FR GA GB GD GE GG GH GI GL GM GN GQ GR GT GW GY HK HN HR HT HU ID IE IL IM IN IQ IR IS IT JE JM JO JP KE KG KH KM KN KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MK ML MM MN MO MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NZ OM PA PE PG PH PK PL PR PS PT PY QA RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SY SZ TD TG TH TJ TL TM TN TO TR TT TW TZ UA UG US UY UZ VA VC VE VN VU WS YE ZA ZM ZW".split(" ");

export function countryOptions(locale: string): { code: string; name: string }[] {
  const names = new Intl.DisplayNames([locale], { type: "region" });
  return COUNTRY_CODES.map((code) => ({ code, name: names.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name, locale));
}

/** Best effort from free text ("Italy", "italia", "IT") to a code, for prefilling forms. */
export function guessCountry(text: string, locale: string): string {
  const v = text.trim().toLowerCase();
  if (!v) return "";
  if (COUNTRY_CODES.includes(v.toUpperCase())) return v.toUpperCase();
  for (const l of [locale, "en"]) {
    const hit = countryOptions(l).find((c) => c.name.toLowerCase() === v);
    if (hit) return hit.code;
  }
  return "";
}
