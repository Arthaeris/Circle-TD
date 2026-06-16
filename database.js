/* =============================================================================
 * Circle Tower Wars — database.js
 * THE CONTENT LIBRARY. Answers: "What exists in the game?"
 * Towers, enemies, projectiles, currencies, statuses, synergies, maps, waves,
 * balancing numbers. No game logic, no rendering, no save logic lives here.
 * ===========================================================================*/
(function (global) {
  "use strict";

  /* ---------------------------------------------------------------------------
   * GLOBAL CONFIG / BALANCING
   * -------------------------------------------------------------------------*/
  const CONFIG = {
    grid: { cols: 31, rows: 61 },          // per-corridor build grid
    portalCols: [15, 16, 17],                 // 3-wide portals, centered
    towerSize: 3,                          // towers occupy 3x3 tiles
    startLives: 20,
    startGold: 420,
    startEssence: 320,                     // per-element starting essence (elemental economy)
    enemyBaseSpeed: 1.55,                  // tiles per second
    sellRefund: 0.6,                       // fraction of total invested returned on sell
    maxLevel: 10,
    maxExpert: 5,
    expertThresholds: [12, 30, 60, 110, 190], // kills needed for expert 1..5
    expertDamageBonus: [0, 0.10, 0.30, 0.50, 0.75, 1.00], // index = expert level
    bossEvery: 10,
    obstacleDensity: 0.03,                 // fraction of buildable tiles seeded as obstacles
    loopLifeLoss: 1,                       // lives lost when an enemy completes a loop to origin
  };

  /* ---------------------------------------------------------------------------
   * ELEMENTS — identity, theme colors, currency, obstacles
   * -------------------------------------------------------------------------*/
  const ELEMENTS = {
    fire:     { id: "fire",     name: "Fire",     currency: "Fire Essence",     starter: true,  color: "#ff6a3d", glow: "#ffb15c", dark: "#5c1d12", icon: "🔥", obstacles: ["Lava Rock", "Obsidian Pillar"] },
    ice:      { id: "ice",      name: "Ice",      currency: "Ice Essence",      starter: true,  color: "#5bd6ff", glow: "#bff0ff", dark: "#10384d", icon: "❄️", obstacles: ["Ice Shard", "Frozen Boulder"] },
    nature:   { id: "nature",   name: "Nature",   currency: "Nature Essence",   starter: true,  color: "#73d35f", glow: "#c6f5b5", dark: "#1d3d17", icon: "🌿", obstacles: ["Ancient Tree", "Root Cluster"] },
    storm:    { id: "storm",    name: "Storm",    currency: "Storm Essence",    starter: true,  color: "#c77dff", glow: "#ecd1ff", dark: "#2e1648", icon: "⚡", obstacles: ["Charged Crystal", "Storm Spire"] },
    light:    { id: "light",    name: "Light",    currency: "Light Essence",    starter: false, color: "#ffe066", glow: "#fff6c2", dark: "#5a4a10", icon: "✨", obstacles: ["Sun Pillar", "Radiant Crystal"] },
    darkness: { id: "darkness", name: "Darkness", currency: "Dark Essence",     starter: false, color: "#8b6cff", glow: "#cbb9ff", dark: "#1c1235", icon: "🌑", obstacles: ["Void Stone", "Bone Pile"] },
    mech:     { id: "mech",     name: "Mech",     currency: "Mech Essence",     starter: false, color: "#9fb3c8", glow: "#d6e2ee", dark: "#27313b", icon: "⚙️", obstacles: ["Generator", "Scrap Pile"] },
    abnormal: { id: "abnormal", name: "Abnormal", currency: "Abnormal Essence", starter: false, color: "#ff5fa2", glow: "#ffc2dd", dark: "#45122c", icon: "🌀", obstacles: ["Rift Fragment", "Glitch Block"] },
  };
  const ELEMENT_ORDER = ["fire", "ice", "nature", "storm", "light", "darkness", "mech", "abnormal"];

  /* ---------------------------------------------------------------------------
   * STATUS EFFECTS
   * kind drives generic engine behavior:
   *   dot      -> damage per second (value = dps fraction of enemy maxHp or flat? we use flat scaled)
   *   slow     -> movement multiplier (value < 1)
   *   stun     -> movement stop (value ignored)
   *   amp      -> damage taken multiplier (value > 1)
   *   shred    -> armor reduction (value = flat armor removed)
   *   curse    -> damage taken on each corridor transition (value = flat)
   *   tag      -> bonus currency multiplier on kill (value = mult)
   *   custom   -> special handling by id in systems.js
   * -------------------------------------------------------------------------*/
  const STATUSES = {
    // Fire
    burning:   { id: "burning",   name: "Burning",   element: "fire",   kind: "dot",   value: 14, duration: 3.0, color: "#ff6a3d", icon: "🔥" },
    molten:    { id: "molten",    name: "Molten",    element: "fire",   kind: "custom", value: 10, duration: 3.5, color: "#ff9d3d", icon: "🌋" },
    volatile:  { id: "volatile",  name: "Volatile",  element: "fire",   kind: "custom", value: 60, duration: 5.0, color: "#ffd23d", icon: "💥" },
    // Ice
    chilled:   { id: "chilled",   name: "Chilled",   element: "ice",    kind: "slow",  value: 0.6, duration: 2.5, color: "#5bd6ff", icon: "🧊" },
    frozen:    { id: "frozen",    name: "Frozen",    element: "ice",    kind: "stun",  value: 0,   duration: 1.6, color: "#bff0ff", icon: "❄️" },
    brittle:   { id: "brittle",   name: "Brittle",   element: "ice",    kind: "amp",   value: 1.4, duration: 4.0, color: "#9fd9ff", icon: "💎" },
    // Nature
    poisoned:  { id: "poisoned",  name: "Poisoned",  element: "nature", kind: "dot",   value: 9,  duration: 4.5, color: "#73d35f", icon: "🟢", spreads: true },
    rooted:    { id: "rooted",    name: "Rooted",    element: "nature", kind: "stun",  value: 0,  duration: 2.0, color: "#4f9e3f", icon: "🌱" },
    sprouting: { id: "sprouting", name: "Sprouting", element: "nature", kind: "amp",   value: 1.3, duration: 4.0, color: "#9be37f", icon: "🌾" },
    // Storm
    shocked:   { id: "shocked",   name: "Shocked",   element: "storm",  kind: "custom", value: 16, duration: 3.0, color: "#c77dff", icon: "⚡" },
    conductive:{ id: "conductive",name: "Conductive",element: "storm",  kind: "custom", value: 0,  duration: 4.0, color: "#d9a6ff", icon: "🔌" },
    lifted:    { id: "lifted",    name: "Lifted",    element: "storm",  kind: "slow",  value: 0.5, duration: 2.5, color: "#e0c2ff", icon: "🌪️" },
    // Light
    illuminated:{id: "illuminated",name:"Illuminated",element:"light",  kind: "amp",   value: 1.35,duration: 4.0, color: "#ffe066", icon: "💡" },
    purified:  { id: "purified",  name: "Purified",  element: "light",  kind: "custom", value: 0,  duration: 0.5, color: "#fff6c2", icon: "🕊️" },
    blinded:   { id: "blinded",   name: "Blinded",   element: "light",  kind: "custom", value: 0,  duration: 3.0, color: "#fff0a3", icon: "🌟" },
    // Darkness
    cursed:    { id: "cursed",    name: "Cursed",    element: "darkness",kind: "curse", value: 45, duration: 6.0, color: "#8b6cff", icon: "💀" },
    weakened:  { id: "weakened",  name: "Weakened",  element: "darkness",kind: "amp",   value: 1.25,duration: 5.0, color: "#a892ff", icon: "🔻" },
    marked:    { id: "marked",    name: "Marked For Death", element: "darkness", kind: "custom", value: 0.18, duration: 5.0, color: "#c8b6ff", icon: "🎯" },
    // Mech
    magnetized:{ id: "magnetized",name: "Magnetized",element: "mech",   kind: "custom", value: 0,  duration: 4.0, color: "#9fb3c8", icon: "🧲" },
    tagged:    { id: "tagged",    name: "Tagged",    element: "mech",   kind: "tag",   value: 2.0, duration: 6.0, color: "#c2d2e2", icon: "🏷️" },
    shredded:  { id: "shredded",  name: "Shredded",  element: "mech",   kind: "shred", value: 6,  duration: 5.0, color: "#cdd9e5", icon: "🔩" },
    // Abnormal
    corrupted: { id: "corrupted", name: "Corrupted Logic", element: "abnormal", kind: "custom", value: 0, duration: 5.0, color: "#ff5fa2", icon: "🌀" },
    fracture:  { id: "fracture",  name: "Reality Fracture",element: "abnormal", kind: "amp",  value: 1.3, duration: 4.0, color: "#ff8fc0", icon: "🪞" },
    entropy:   { id: "entropy",   name: "Entropy",   element: "abnormal",kind: "custom", value: 0, duration: 6.0, color: "#ffb3d4", icon: "♾️" },
    // Loop-based adaptation statuses (applied by the engine, not towers)
    momentum:  { id: "momentum",  name: "Momentum",  element: "abnormal",kind: "custom", value: 1.4, duration: 9.0, color: "#ffd23d", icon: "🏃", adaptive: true },
    hardened:  { id: "hardened",  name: "Hardened",  element: "abnormal",kind: "custom", value: 0,   duration: 9.0, color: "#cdd9e5", icon: "🛡️", adaptive: true },
    veteran:   { id: "veteran",   name: "Veteran",   element: "abnormal",kind: "custom", value: 0,   duration: 12.0,color: "#ffcf8f", icon: "🎖️", adaptive: true },
  };

  /* ---------------------------------------------------------------------------
   * CROSS-FIELD SYNERGIES
   * Keyed "<existingStatusId>|<incomingElementId>".
   * Fired by systems.js when a new element's status is applied to an enemy that
   * already carries `existingStatusId`.
   * -------------------------------------------------------------------------*/
  const SYNERGIES = {
    "burning|ice":       { id: "thermal_shock", name: "Thermal Shock", burst: 90,  color: "#bff0ff" },
    "burning|nature":    { id: "wildfire",      name: "Wildfire",      spread: true, burst: 30, color: "#ff9d3d" },
    "burning|storm":     { id: "firestorm",     name: "Firestorm",     burst: 50,  color: "#ffb15c" },
    "poisoned|storm":    { id: "neuroshock",    name: "Neuroshock",    dotMult: 2.0, color: "#a6ff9b" },
    "poisoned|fire":     { id: "combustion",    name: "Combustion",    burst: 55,  color: "#ff6a3d" },
    "conductive|darkness":{ id: "dark_conduit", name: "Dark Conduit",  curseBoost: 2.0, color: "#8b6cff" },
    "shocked|mech":      { id: "overload",      name: "Overload",      burst: 45,  color: "#cdd9e5" },
    "sprouting|light":   { id: "bloom",         name: "Bloom",         spread: true, color: "#c6f5b5" },
    "chilled|fire":      { id: "steam",         name: "Steam",         burst: 40,  color: "#dfeff5" },
    "frozen|fire":       { id: "thermal_shock", name: "Thermal Shock", burst: 100, color: "#ffd23d" },
    "magnetized|storm":  { id: "storm_anchor",  name: "Storm Anchor",  anchor: true, burst: 25, color: "#d9a6ff" },
    "marked|darkness":   { id: "execution",     name: "Execution",     execute: 0.25, color: "#c8b6ff" },
    "illuminated|light": { id: "supernova",     name: "Supernova",     burst: 70,  color: "#fff6c2" },
    "weakened|mech":     { id: "demolition",    name: "Demolition",    burst: 60,  color: "#cdd9e5" },
  };

  /* ---------------------------------------------------------------------------
   * TOWERS — 8 elements x 5 towers = 40
   * tier = element-mastery level required (towers 1..5 -> 0,0,1,2,4)
   * archetype: single | splash | beam | chain | melee | support | random
   * Each tower has two mutation paths unlocked at max level.
   * -------------------------------------------------------------------------*/
  const TOWER_TIERS = [0, 0, 1, 2, 4];

  function T(element, idx, name, archetype, stats, status, mutations, desc) {
    return Object.assign({
      id: element + "_" + idx,
      element: element,
      name: name,
      tier: TOWER_TIERS[idx],
      slot: idx,
      archetype: archetype,
      status: status || null,
      mutations: mutations || [],
      desc: desc || "",
      // archetype defaults
      splashRadius: 0,
      chainCount: 0,
      chainRange: 0,
      pierce: 0,
      auraStat: null,
      auraValue: 0,
    }, stats);
  }
  // mutation helper
  function M(id, name, desc, mods) { return { id, name, desc, mods }; }

  const TOWERS = [
    /* ===== FIRE — aggressive damage ===== */
    T("fire", 0, "Flame Tower", "single",
      { cost: 90, damage: 18, range: 4.0, fireRate: 1.4, projectileSpeed: 11, statusChance: 0.7, statusDuration: 3 }, "burning",
      [ M("volcanic","Volcanic Path","Bigger burns, splash on impact.",{archetype:"splash",splashRadius:1.4,damageMult:1.2}),
        M("phoenix","Phoenix Path","Rapid fire, ignites on every hit.",{fireRateMult:1.8,statusChance:1.0}) ],
      "Reliable single-target burner."),
    T("fire", 1, "Fireball Tower", "splash",
      { cost: 130, damage: 26, range: 3.6, fireRate: 0.85, projectileSpeed: 8, splashRadius: 1.5, statusChance: 0.5, statusDuration: 3 }, "burning",
      [ M("meteor","Meteor","Huge blast radius, slower cadence.",{splashRadius:2.6,damageMult:1.5,fireRateMult:0.7}),
        M("cluster","Cluster","Smaller blasts, fires twice as fast.",{fireRateMult:2.0,splashRadius:1.1}) ],
      "Lobs explosive fireballs."),
    T("fire", 2, "Magma Tower", "splash",
      { cost: 180, damage: 30, range: 3.2, fireRate: 0.7, splashRadius: 1.6, statusChance: 0.9, statusDuration: 3.5 }, "molten",
      [ M("eruption","Eruption","Leaves lingering magma pools.",{moltenBoost:true,damageMult:1.2}),
        M("magmacore","Magma Core","Massive direct damage.",{damageMult:1.8,splashRadius:1.3}) ],
      "Coats the ground in molten fire."),
    T("fire", 3, "Inferno Tower", "beam",
      { cost: 260, damage: 9, range: 4.2, fireRate: 8, statusChance: 0.4, statusDuration: 3 }, "burning",
      [ M("pyroclasm","Pyroclasm","Beam splits to a second target.",{chainCount:1,chainRange:3.5}),
        M("solarflare","Solar Flare","Beam burns far hotter.",{damageMult:1.9,rangeMult:1.2}) ],
      "Continuous searing beam."),
    T("fire", 4, "Phoenix Spire", "splash",
      { cost: 420, damage: 70, range: 4.4, fireRate: 0.7, projectileSpeed: 9, splashRadius: 2.0, statusChance: 1.0, statusDuration: 4 }, "volatile",
      [ M("rebirth","Rebirth","Volatile blasts chain into others.",{volatileChain:true,damageMult:1.3}),
        M("sunfire","Sunfire","Devastating single bombs.",{damageMult:2.0,fireRateMult:0.8}) ],
      "Apex fire artillery; marks enemies Volatile."),

    /* ===== ICE — control ===== */
    T("ice", 0, "Frost Tower", "single",
      { cost: 85, damage: 12, range: 4.0, fireRate: 1.2, projectileSpeed: 10, statusChance: 0.9, statusDuration: 2.5 }, "chilled",
      [ M("deepchill","Deep Chill","Stronger, longer slow.",{slowBoost:true,statusDuration:4}),
        M("frostbite","Frostbite","Adds damage over time.",{damageMult:1.6}) ],
      "Slows enemies reliably."),
    T("ice", 1, "Icicle Tower", "single",
      { cost: 120, damage: 22, range: 4.6, fireRate: 1.6, projectileSpeed: 16, pierce: 2, statusChance: 0.5, statusDuration: 2 }, "chilled",
      [ M("shatter","Shatter","Icicles pierce everything in a line.",{pierce:6,damageMult:1.2}),
        M("frostlance","Frost Lance","Fewer, far harder hits.",{damageMult:2.0,fireRateMult:0.7}) ],
      "Piercing icicles."),
    T("ice", 2, "Glacier Tower", "splash",
      { cost: 190, damage: 24, range: 3.4, fireRate: 0.6, splashRadius: 1.6, statusChance: 0.7, statusDuration: 1.6 }, "frozen",
      [ M("permafrost","Permafrost","Freezes a wider area.",{splashRadius:2.4,statusDuration:2.2}),
        M("avalanche","Avalanche","Crushing impact damage.",{damageMult:1.8}) ],
      "Freezes clustered enemies."),
    T("ice", 3, "Blizzard Tower", "support",
      { cost: 240, damage: 6, range: 3.6, fireRate: 1.0, auraStat: "slow", auraValue: 0.7, statusChance: 1.0, statusDuration: 1.2 }, "chilled",
      [ M("whiteout","Whiteout","Slows everything far harder.",{auraValue:0.45}),
        M("hailstorm","Hailstorm","Aura also deals steady damage.",{damageMult:3.0}) ],
      "Aura that chills all enemies in range."),
    T("ice", 4, "Absolute Zero", "splash",
      { cost: 400, damage: 40, range: 4.0, fireRate: 0.55, splashRadius: 2.0, statusChance: 1.0, statusDuration: 2.4 }, "frozen",
      [ M("zeropoint","Zero Point","Also makes targets Brittle.",{addStatus:"brittle"}),
        M("cryostasis","Cryostasis","Longer, guaranteed freezes.",{statusDuration:3.4,damageMult:1.3}) ],
      "Mass-freeze finisher."),

    /* ===== NATURE — attrition ===== */
    T("nature", 0, "Thorn Tower", "single",
      { cost: 80, damage: 16, range: 3.8, fireRate: 1.3, projectileSpeed: 12, statusChance: 0.6, statusDuration: 4.5 }, "poisoned",
      [ M("barbed","Barbed","Poison hits harder.",{damageMult:1.5}),
        M("rapidthorn","Rapid Thorn","Fires far faster.",{fireRateMult:1.9}) ],
      "Cheap poison applicator."),
    T("nature", 1, "Spore Tower", "splash",
      { cost: 125, damage: 14, range: 3.4, fireRate: 0.9, splashRadius: 1.7, statusChance: 0.9, statusDuration: 4.5 }, "poisoned",
      [ M("plague","Plague","Poison spreads aggressively.",{spreadBoost:true,damageMult:1.2}),
        M("toxincloud","Toxin Cloud","Bigger lingering clouds.",{splashRadius:2.5}) ],
      "Spreads poison clouds."),
    T("nature", 2, "Bramble Tower", "single",
      { cost: 175, damage: 20, range: 3.6, fireRate: 1.0, projectileSpeed: 11, statusChance: 0.8, statusDuration: 2.0 }, "rooted",
      [ M("entangle","Entangle","Roots last much longer.",{statusDuration:3.4}),
        M("ironroot","Iron Root","Roots and crushes for damage.",{damageMult:1.8}) ],
      "Roots enemies in place."),
    T("nature", 3, "Venom Tower", "single",
      { cost: 250, damage: 30, range: 4.2, fireRate: 1.1, projectileSpeed: 13, statusChance: 1.0, statusDuration: 5 }, "sprouting",
      [ M("necrosis","Necrosis","Devastating stacking poison.",{damageMult:1.6,addStatus:"poisoned"}),
        M("bloomling","Bloomling","Death spores hit everyone nearby.",{splashOnDeath:true}) ],
      "Lethal toxins; makes enemies Sprouting."),
    T("nature", 4, "World Tree", "support",
      { cost: 410, damage: 10, range: 4.0, fireRate: 1.0, auraStat: "poison", auraValue: 8, statusChance: 1.0, statusDuration: 4 }, "poisoned",
      [ M("grove","Grove","Heals your lives slowly over time.",{regen:true}),
        M("ancient","Ancient","Aura poison far stronger.",{auraValue:20,damageMult:2}) ],
      "Ancient guardian; poisons the whole field."),

    /* ===== STORM — coverage ===== */
    T("storm", 0, "Spark Tower", "single",
      { cost: 88, damage: 17, range: 4.2, fireRate: 1.5, projectileSpeed: 18, statusChance: 0.6, statusDuration: 3 }, "shocked",
      [ M("staticfield","Static Field","Shock arcs farther.",{shockBoost:true}),
        M("supercharge","Supercharge","Heavy single hits.",{damageMult:1.7}) ],
      "Fast-firing shocker."),
    T("storm", 1, "Tesla Tower", "chain",
      { cost: 140, damage: 20, range: 4.0, fireRate: 1.0, chainCount: 3, chainRange: 3.0, statusChance: 0.5, statusDuration: 3 }, "shocked",
      [ M("arcnet","Arc Net","Chains to far more targets.",{chainCount:6}),
        M("highvoltage","High Voltage","Each arc hits harder.",{damageMult:1.6}) ],
      "Lightning that jumps between foes."),
    T("storm", 2, "Cyclone Tower", "splash",
      { cost: 185, damage: 22, range: 3.6, fireRate: 0.8, splashRadius: 1.8, statusChance: 0.8, statusDuration: 2.5 }, "lifted",
      [ M("twister","Twister","Lifts a wide area.",{splashRadius:2.6,statusDuration:3.4}),
        M("downburst","Downburst","Slams for big damage.",{damageMult:1.8}) ],
      "Tornadoes that lift and scatter."),
    T("storm", 3, "Thunder Tower", "chain",
      { cost: 255, damage: 30, range: 4.4, fireRate: 0.9, chainCount: 4, chainRange: 3.4, statusChance: 0.7, statusDuration: 3 }, "conductive",
      [ M("stormcaller","Stormcaller","Marks targets Conductive for huge chains.",{chainCount:7}),
        M("thunderclap","Thunderclap","Colossal arc damage.",{damageMult:1.9}) ],
      "Heavy chain lightning; sets Conductive."),
    T("storm", 4, "Storm Nexus", "chain",
      { cost: 415, damage: 38, range: 4.8, fireRate: 1.1, chainCount: 6, chainRange: 3.6, statusChance: 1.0, statusDuration: 3 }, "shocked",
      [ M("tempest","Tempest","Endless chaining storm.",{chainCount:12}),
        M("eyeofstorm","Eye of Storm","Each link devastates.",{damageMult:1.8,chainCount:4}) ],
      "Field-wide chain coverage."),

    /* ===== LIGHT — support ===== */
    T("light", 0, "Beam Tower", "beam",
      { cost: 95, damage: 8, range: 4.6, fireRate: 9, statusChance: 0.5, statusDuration: 4 }, "illuminated",
      [ M("focus","Focus","Beam ramps damage on a held target.",{rampBoost:true}),
        M("widebeam","Wide Beam","Beam grazes a second foe.",{chainCount:1,chainRange:2.5}) ],
      "Sustained holy beam; amplifies damage taken."),
    T("light", 1, "Prism Tower", "chain",
      { cost: 135, damage: 16, range: 4.0, fireRate: 1.1, chainCount: 3, chainRange: 2.8, statusChance: 0.6, statusDuration: 4 }, "illuminated",
      [ M("refraction","Refraction","Splits into many beams.",{chainCount:6}),
        M("laser","Concentrated","One brutal beam.",{damageMult:1.9,chainCount:0}) ],
      "Splits light across multiple foes."),
    T("light", 2, "Sanctuary", "support",
      { cost: 200, damage: 0, range: 3.8, fireRate: 1.0, auraStat: "amp_tower", auraValue: 1.3 }, null,
      [ M("blessing","Blessing","Bigger damage buff to towers.",{auraValue:1.55}),
        M("hastearray","Haste Array","Buffs attack speed instead.",{auraStat:"haste_tower",auraValue:1.4}) ],
      "Buffs nearby towers' damage."),
    T("light", 3, "Radiance Tower", "splash",
      { cost: 250, damage: 22, range: 3.6, fireRate: 0.9, splashRadius: 1.8, statusChance: 1.0, statusDuration: 4 }, "illuminated",
      [ M("purify","Purifier","Strips enemy buffs (Purified).",{addStatus:"purified"}),
        M("flashbang","Flashbang","Briefly blinds enemies.",{addStatus:"blinded"}) ],
      "Radiant burst; reveals and weakens."),
    T("light", 4, "Solar Spire", "beam",
      { cost: 420, damage: 14, range: 5.0, fireRate: 10, statusChance: 1.0, statusDuration: 4 }, "illuminated",
      [ M("sunlance","Sun Lance","Pierces the whole lane.",{chainCount:3,chainRange:4}),
        M("zenith","Zenith","Annihilating focused beam.",{damageMult:2.2}) ],
      "Apex beam; pure radiant power."),

    /* ===== DARKNESS — debilitation ===== */
    T("darkness", 0, "Shadow Tower", "single",
      { cost: 92, damage: 20, range: 4.0, fireRate: 1.2, projectileSpeed: 12, statusChance: 0.6, statusDuration: 5 }, "weakened",
      [ M("umbra","Umbra","Weaken hits harder, lasts longer.",{statusDuration:7}),
        M("nightblade","Nightblade","Heavy shadow strikes.",{damageMult:1.7}) ],
      "Weakens and wears down."),
    T("darkness", 1, "Curse Tower", "single",
      { cost: 140, damage: 14, range: 4.2, fireRate: 1.0, projectileSpeed: 11, statusChance: 1.0, statusDuration: 6 }, "cursed",
      [ M("hex","Hex","Curse transition damage doubled.",{curseBoost:true}),
        M("doom","Doom","Curse also weakens.",{addStatus:"weakened"}) ],
      "Curses foes — they bleed at every corridor."),
    T("darkness", 2, "Void Tower", "splash",
      { cost: 185, damage: 28, range: 3.4, fireRate: 0.8, splashRadius: 1.7, statusChance: 0.8, statusDuration: 5 }, "weakened",
      [ M("singularity","Singularity","Pulls and crushes a wide area.",{splashRadius:2.6,damageMult:1.2}),
        M("voidrend","Void Rend","Tears single targets apart.",{damageMult:1.9,splashRadius:1.2}) ],
      "Collapsing void blasts."),
    T("darkness", 3, "Reaper Tower", "single",
      { cost: 260, damage: 34, range: 4.4, fireRate: 1.0, projectileSpeed: 14, statusChance: 1.0, statusDuration: 5 }, "marked",
      [ M("harvest","Harvest","Executes low-health foes.",{executeBoost:true}),
        M("scythe","Scythe","Cleaves nearby enemies.",{archetype:"splash",splashRadius:1.5}) ],
      "Marks for Death; executes the weak."),
    T("darkness", 4, "Eclipse Spire", "splash",
      { cost: 420, damage: 60, range: 4.2, fireRate: 0.65, projectileSpeed: 9, splashRadius: 2.0, statusChance: 1.0, statusDuration: 6 }, "cursed",
      [ M("blackhole","Black Hole","Massive area curse and damage.",{splashRadius:2.8,curseBoost:true}),
        M("annihilate","Annihilate","Apocalyptic single blasts.",{damageMult:2.0}) ],
      "Ultimate darkness; mass curse."),

    /* ===== MECH — technology ===== */
    T("mech", 0, "Gun Turret", "single",
      { cost: 85, damage: 9, range: 4.0, fireRate: 3.2, projectileSpeed: 20, statusChance: 0.4, statusDuration: 5 }, "shredded",
      [ M("gatling","Gatling","Spins up to absurd fire rate.",{fireRateMult:2.0}),
        M("ap_rounds","AP Rounds","Armor-piercing heavy rounds.",{damageMult:1.8,pierce:2}) ],
      "Rapid-fire bullets; shreds armor."),
    T("mech", 1, "Saw Blade", "melee",
      { cost: 130, damage: 12, range: 1.8, fireRate: 4.0, auraStat: "melee", auraValue: 0, statusChance: 0.7, statusDuration: 5 }, "shredded",
      [ M("buzzsaw","Buzzsaw","Wider, faster blades.",{rangeMult:1.5,fireRateMult:1.4}),
        M("rendingsaw","Rending Saw","Brutal shred damage.",{damageMult:2.0}) ],
      "Melee blades that grind adjacent foes."),
    T("mech", 2, "Railgun", "single",
      { cost: 200, damage: 55, range: 5.2, fireRate: 0.5, projectileSpeed: 26, pierce: 3, statusChance: 0.6, statusDuration: 5 }, "shredded",
      [ M("overcharge","Overcharge","Pierces the entire lane.",{pierce:10,damageMult:1.2}),
        M("siege","Siege","Single annihilating shot.",{damageMult:2.0,fireRateMult:0.8}) ],
      "Long-range piercing cannon."),
    T("mech", 3, "Magnet Tower", "support",
      { cost: 240, damage: 6, range: 3.8, fireRate: 1.0, auraStat: "magnet", auraValue: 1, statusChance: 1.0, statusDuration: 4 }, "magnetized",
      [ M("polarize","Polarize","Magnetizes a wider field.",{rangeMult:1.4}),
        M("railsync","Rail Sync","Buffs nearby tower damage too.",{auraStat:"amp_tower",auraValue:1.3}) ],
      "Magnetizes foes — projectiles seek them."),
    T("mech", 4, "War Factory", "splash",
      { cost: 410, damage: 36, range: 4.0, fireRate: 1.4, splashRadius: 1.7, statusChance: 1.0, statusDuration: 6 }, "tagged",
      [ M("artillery","Artillery","Long-range heavy shells.",{rangeMult:1.4,damageMult:1.4}),
        M("droneswarm","Drone Swarm","Tags everything for bonus loot.",{tagBoost:true,fireRateMult:1.5}) ],
      "Mass production of pain; Tags for loot."),

    /* ===== ABNORMAL — unpredictability ===== */
    T("abnormal", 0, "Glitch Tower", "random",
      { cost: 95, damage: 18, range: 4.0, fireRate: 1.3, projectileSpeed: 13, statusChance: 0.8, statusDuration: 5 }, "corrupted",
      [ M("overclock","Overclock","Glitches in your favor more often.",{luckyBoost:true}),
        M("hardcrash","Hard Crash","Bigger random spikes.",{damageMult:1.5}) ],
      "Random element & effect each shot."),
    T("abnormal", 1, "Warp Tower", "splash",
      { cost: 135, damage: 24, range: 3.6, fireRate: 0.9, splashRadius: 1.7, statusChance: 0.8, statusDuration: 4 }, "fracture",
      [ M("rift","Rift","Larger reality-tearing blasts.",{splashRadius:2.6}),
        M("phaseshift","Phase Shift","Hits twice unpredictably.",{fireRateMult:1.8}) ],
      "Warps space; Reality Fracture."),
    T("abnormal", 2, "Chaos Tower", "random",
      { cost: 190, damage: 30, range: 4.2, fireRate: 1.1, statusChance: 1.0, statusDuration: 5 }, "entropy",
      [ M("pandemonium","Pandemonium","Chaos affects many foes.",{chainCount:4,chainRange:3}),
        M("singularity2","Maelstrom","Concentrated chaos.",{damageMult:1.8}) ],
      "Pure chaos; applies Entropy."),
    T("abnormal", 3, "Paradox Tower", "chain",
      { cost: 255, damage: 26, range: 4.4, fireRate: 1.0, chainCount: 4, chainRange: 3.2, statusChance: 1.0, statusDuration: 5 }, "corrupted",
      [ M("recursion","Recursion","Chains can loop back.",{chainCount:8}),
        M("paradoxcore","Paradox Core","Devastating paradox arcs.",{damageMult:1.8}) ],
      "Impossible chains of corrupted logic."),
    T("abnormal", 4, "Reality Engine", "random",
      { cost: 430, damage: 50, range: 4.6, fireRate: 1.0, splashRadius: 1.8, statusChance: 1.0, statusDuration: 6 }, "entropy",
      [ M("rewrite","Rewrite","Rewrites enemies into weaker forms.",{rewriteBoost:true}),
        M("omega","Omega","Reality-ending output.",{damageMult:2.2}) ],
      "Endgame chaos; bends every rule."),
  ];

  const TOWER_BY_ID = {};
  TOWERS.forEach(t => TOWER_BY_ID[t.id] = t);

  /* ---------------------------------------------------------------------------
   * TOWER STAT SCALING (normal levels 1..10)
   * -------------------------------------------------------------------------*/
  const SCALING = {
    damagePerLevel: 0.17,      // +17% damage per level (compounding)
    fireRatePerLevel: 0.075,    // +7.5% attack speed per level
    rangePerLevel: 0.5,       // +0.5 tiles range per level (flat)
    upgradeCostBase: 0.55,     // upgrade cost = baseCost * upgradeCostBase * costGrowth^(level-1)
    costGrowth: 1.28,
  };

  /* ---------------------------------------------------------------------------
   * ENEMIES
   * -------------------------------------------------------------------------*/
  const ENEMIES = {
    grunt:  { id: "grunt",  name: "Imp",       hp: 60,  speed: 1.0, armor: 0,  reward: 9,  radius: 0.32, color: "#d96b4a" },
    runner: { id: "runner", name: "Sprite",    hp: 34,  speed: 1.7, armor: 0,  reward: 8,  radius: 0.26, color: "#e0c14a" },
    swarm:  { id: "swarm",  name: "Mite",      hp: 20,  speed: 1.3, armor: 0,  reward: 4,  radius: 0.20, color: "#8fb84a" },
    brute:  { id: "brute",  name: "Golem",     hp: 200, speed: 0.7, armor: 6,  reward: 22, radius: 0.42, color: "#7a8aa0" },
    tank:   { id: "tank",   name: "Behemoth",  hp: 420, speed: 0.55,armor: 12, reward: 40, radius: 0.5,  color: "#5a6b86" },
    boss:   { id: "boss",   name: "Warlord",   hp: 2400,speed: 0.5, armor: 14, reward: 220,radius: 0.7,  color: "#b03b6b", boss: true },
    endboss:{ id: "endboss",name: "The Sealed One", hp: 18000, speed: 0.42, armor: 20, reward: 1500, radius: 0.95, color: "#ff2e7e", boss: true, end: true },
  };

  /* ---------------------------------------------------------------------------
   * WAVE GENERATION
   * Returns an array of spawn entries for a given wave number.
   * Each entry: { type, count, gap (s), delay (s before group) }
   * -------------------------------------------------------------------------*/
  function generateWave(wave, corridorCount) {
    const isBoss = wave % CONFIG.bossEvery === 0;
    const entries = [];
    const intensity = 1 + (wave - 1) * 0.08;

    if (isBoss) {
      entries.push({ type: "boss", count: 1, gap: 0, delay: 0 });
      // boss escorts
      const escorts = 4 + Math.floor(wave / 10) * 2;
      entries.push({ type: "brute", count: escorts, gap: 1.1, delay: 2 });
      entries.push({ type: "runner", count: escorts * 2, gap: 0.5, delay: 1 });
      return entries;
    }

    const base = 6 + Math.floor(wave * 0.7);
    entries.push({ type: "grunt", count: Math.round(base * 0.6 * intensity / intensity), gap: 0.75, delay: 0 });
    entries.push({ type: "runner", count: Math.round((3 + wave * 0.3)), gap: 0.45, delay: 0.6 });
    if (wave >= 4) entries.push({ type: "swarm", count: Math.round(6 + wave * 0.6), gap: 0.22, delay: 1.4 });
    if (wave >= 6) entries.push({ type: "brute", count: 1 + Math.floor(wave / 6), gap: 1.3, delay: 2.2 });
    if (wave >= 12) entries.push({ type: "tank", count: Math.floor(wave / 12), gap: 1.8, delay: 3 });
    return entries;
  }

  // HP/speed scaling per wave (used by systems.js when spawning)
  function enemyScale(wave) {
    return {
      hp: 1 + (wave - 1) * 0.16 + Math.pow(wave / 12, 2) * 0.5,
      speed: 1 + Math.min(0.5, (wave - 1) * 0.012),
      reward: 1 + (wave - 1) * 0.03,
    };
  }

  function totalWaves(mode, corridorCount) {
    if (mode === "endless") return Infinity;
    if (mode === "single") return 10;
    return corridorCount * 10;
  }

  /* ---------------------------------------------------------------------------
   * POLYGON LAYOUTS for the World Map (unit circle coords, y-down)
   * -------------------------------------------------------------------------*/
  function polygonPoints(n) {
    if (n === 1) return [{ x: 0, y: 0 }];
    const pts = [];
    const start = -Math.PI / 2; // first vertex at top
    for (let i = 0; i < n; i++) {
      const a = start + (i / n) * Math.PI * 2;
      pts.push({ x: Math.cos(a), y: Math.sin(a) });
    }
    return pts;
  }
  const SHAPE_NAMES = { 1: "Single Lane", 3: "Triangle", 4: "Square", 5: "Pentagon", 6: "Hexagon", 7: "Heptagon", 8: "Octagon" };

  /* ---------------------------------------------------------------------------
   * PROGRESSION / MASTERY
   * -------------------------------------------------------------------------*/
  const MASTERY = {
    // requirement to REACH each level (index = target level)
    winsRequired: { 1: 1, 2: 3, 3: 10, 4: 20 }, // level 5 = reach wave 100
    // what each level unlocks
    unlocks: {
      0: ["Tower 1", "Tower 2"],
      1: ["Tower 3"],
      2: ["Tower 4"],
      3: ["Mutation Slot 1"],
      4: ["Tower 5"],
      5: ["Mutation Slot 2"],
    },
    mutationSlots: { 3: 1, 5: 2 }, // mastery level -> total mutation slots available
  };

  // How many towers of an element are unlocked at a given mastery level
  function unlockedTowerSlots(masteryLevel) {
    if (masteryLevel >= 4) return 5;
    if (masteryLevel >= 2) return 4;
    if (masteryLevel >= 1) return 3;
    return 2;
  }
  function mutationSlotsAvailable(masteryLevel) {
    if (masteryLevel >= 5) return 2;
    if (masteryLevel >= 3) return 1;
    return 0;
  }

  // Element availability given a mastery map {fire:lvl,...}
  function availableElements(mastery) {
    const avail = new Set(ELEMENT_ORDER.filter(e => ELEMENTS[e].starter));
    const startersAt1 = ["fire", "ice", "nature", "storm"].every(e => (mastery[e] || 0) >= 1);
    if (startersAt1) { avail.add("light"); avail.add("darkness"); }
    const anyAt5 = ELEMENT_ORDER.some(e => (mastery[e] || 0) >= 5);
    if (anyAt5) { avail.add("mech"); avail.add("abnormal"); }
    return ELEMENT_ORDER.filter(e => avail.has(e));
  }

  const CORRIDOR_OPTIONS = [1, 3, 4, 5, 6, 7, 8];

  /* ---------------------------------------------------------------------------
   * EXPORT
   * -------------------------------------------------------------------------*/
  global.DB = {
    CONFIG, ELEMENTS, ELEMENT_ORDER, STATUSES, SYNERGIES,
    TOWERS, TOWER_BY_ID, TOWER_TIERS, SCALING,
    ENEMIES, MASTERY, SHAPE_NAMES, CORRIDOR_OPTIONS,
    generateWave, enemyScale, totalWaves, polygonPoints,
    unlockedTowerSlots, mutationSlotsAvailable, availableElements,
    version: 1,
  };
})(typeof window !== "undefined" ? window : this);