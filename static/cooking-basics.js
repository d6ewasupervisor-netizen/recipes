/**
 * Common cooking knowledge for instant voice answers (mirrors cooking_basics.py).
 */

const BASICS = [
  [
    /\b(medium|rare|medium.?rare|medium.?well|well.?done)\b.*\bsteak\b|\bsteak\b.*\b(medium|rare|medium.?rare|medium.?well|well.?done|doneness|temp)\b/i,
    "Steak doneness by internal temp: rare one hundred twenty-five, medium-rare one hundred thirty-five, medium one hundred forty-five, medium-well one hundred fifty-five, well-done one hundred sixty plus degrees Fahrenheit. Pull a few degrees early and rest five minutes.",
  ],
  [
    /\b(safe|internal|done|temp)\b.*\bpork\b|\bpork\b.*\b(safe|internal|temp|done)\b/i,
    "Pork is safely done at one hundred forty-five degrees Fahrenheit internal, then rest three minutes.",
  ],
  [
    /\b(safe|internal|done|temp)\b.*\b(chicken|poultry|turkey)\b|\b(chicken|poultry|turkey)\b.*\b(safe|internal|temp|done)\b/i,
    "Poultry is safely done at one hundred sixty-five degrees Fahrenheit in the thickest part, not touching bone.",
  ],
  [
    /\b(safe|internal|done|temp)\b.*\b(ground beef|ground meat|hamburger|burger)\b|\b(ground beef|ground meat|hamburger)\b.*\b(safe|temp|done)\b/i,
    "Ground beef and other ground meats should reach one hundred sixty degrees Fahrenheit internal.",
  ],
  [
    /\b(safe|internal|done|temp)\b.*\b(fish|seafood|salmon|shrimp)\b|\b(fish|salmon|shrimp)\b.*\b(safe|temp|done)\b/i,
    "Fish is usually done at one hundred forty-five degrees Fahrenheit, or when it flakes easily. Shrimp turns pink and opaque.",
  ],
  [
    /\b(substitut|swap|replace|instead of)\b.*\bbutter\b|\bbutter\b.*\b(substitut|instead|swap)\b/i,
    "For butter, use equal oil for sautéing, or three-quarters oil plus a pinch of salt for baking. Margarine works one-to-one in most recipes.",
  ],
  [
    /\b(substitut|swap|replace|instead of)\b.*\b(milk|cream|buttermilk)\b|\b(milk|buttermilk)\b.*\b(substitut|instead|swap)\b/i,
    "Milk swaps: whole milk for cream in most cooking, half-and-half for lighter richness. Buttermilk: one cup milk plus one tablespoon lemon juice or vinegar, rest five minutes.",
  ],
  [
    /\b(substitut|swap|replace|instead of)\b.*\b(egg|eggs)\b|\beggs?\b.*\b(substitut|instead|swap)\b/i,
    "One egg binds about one-quarter cup: try one tablespoon flax meal plus three tablespoons water, or one-quarter cup applesauce or mashed banana in baking.",
  ],
  [
    /\b(substitut|swap|replace|instead of)\b.*\b(flour|all.?purpose)\b|\bflour\b.*\b(substitut|instead|gluten.?free)\b/i,
    "For gluten-free, use a one-to-one gluten-free flour blend. Cake flour: subtract two tablespoons per cup of all-purpose and add two tablespoons cornstarch.",
  ],
  [
    /\bwhat (is|does)\b.*\b(saut[eé]|braise|blanch|deglaze|reduce|proof|rest|fold)\b|\b(saut[eé]|braise|blanch|deglaze|reduce|proof)\b.*\bmean\b/i,
    "Sauté: cook quickly in a little fat over medium-high heat. Braise: brown then simmer covered in liquid until tender. Blanch: brief boil then ice bath. Deglaze: loosen browned bits with liquid. Reduce: simmer to thicken and concentrate flavor.",
  ],
  [
    /\b(food safety|cross.?contam|raw chicken|wash hands|leftovers)\b/i,
    "Keep raw meat separate from ready-to-eat food. Wash hands and surfaces after touching raw protein. Refrigerate leftovers within two hours. Reheat to one hundred sixty-five degrees Fahrenheit.",
  ],
  [
    /\b(dutch oven|cast iron|nonstick|sheet pan|stand mixer|food processor)\b.*\b(what|when|use)\b|\bwhat (is|for)\b.*\b(dutch oven|cast iron|nonstick|sheet pan)\b/i,
    "Dutch oven: heavy pot for braising, soups, and bread. Cast iron holds heat well for searing and baking. Nonstick is best for eggs and delicate foods on low to medium heat.",
  ],
  [
    /\b(room temp|room temperature)\b.*\b(butter|eggs|cream cheese)\b|\bwhy\b.*\broom temp\b/i,
    "Room-temperature butter and eggs cream and emulsify better, giving smoother batters and even baking.",
  ],
  [
    /\b(al dente|mise en place|julienne|chiffonade)\b/i,
    "Al dente: pasta with a slight bite. Mise en place: prep and measure everything before cooking. Julienne: thin matchstick cuts. Chiffonade: roll leaves and slice into ribbons.",
  ],
];

/** @returns {string|null} */
export function tryCookingBasicsAnswer(transcript) {
  const t = transcript.toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return null;
  for (const [re, answer] of BASICS) {
    if (re.test(t)) return answer;
  }
  return null;
}
