var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/route_editor_logic.ts
var route_editor_logic_exports = {};
__export(route_editor_logic_exports, {
  VISIT_SHARED_FIELDS: () => VISIT_SHARED_FIELDS,
  automaticRouteName: () => automaticRouteName,
  automaticTemplateName: () => automaticTemplateName,
  cloneVisitParameters: () => cloneVisitParameters,
  compareProfiles: () => compareProfiles,
  differenceFields: () => differenceFields,
  minimumResidencyConstraint: () => minimumResidencyConstraint,
  normalizeStageProcessRecipes: () => normalizeStageProcessRecipes,
  processProfile: () => processProfile,
  processRecipeName: () => processRecipeName,
  replaceCandidates: () => replaceCandidates,
  routeCleanSignature: () => routeCleanSignature,
  selectReferencedRoutes: () => selectReferencedRoutes,
  synchronizeVisits: () => synchronizeVisits
});
var VISIT_SHARED_FIELDS = [
  "processTime",
  "recipeTime",
  "processRecipe",
  "processType",
  "slotIds",
  "weight",
  "moveTimeOffset",
  "qTimeLimit",
  "residencyConstraint",
  "beforeCleanRefs",
  "afterCleanRefs"
];
function cloneValue(value) {
  return value === void 0 ? value : structuredClone(value);
}
function cloneVisitParameters(visit) {
  return Object.fromEntries(
    VISIT_SHARED_FIELDS.map((key) => [key, cloneValue(visit?.[key])])
  );
}
function processProfile(route) {
  const processStages = (route.stages || []).filter((stage) => stage.needProcess);
  const candidateGroups = processStages.map((stage) => [
    ...new Set((stage.visits || []).map((visit) => String(visit.stationName || "").trim()).filter(Boolean))
  ]);
  const counts = candidateGroups.map((candidates) => candidates.length);
  const candidatePath = candidateGroups.map(
    (candidates) => candidates.join("/") || "\u672A\u9009\u62E9\u8154\u5BA4"
  );
  const processTimes = processStages.map(
    (stage) => Number(stage.visits?.[0]?.processTime ?? stage.visits?.[0]?.recipeTime ?? 0)
  );
  const processCount = processStages.length;
  const candidateOccurrences = candidateGroups.flat();
  const isReentrant = new Set(candidateOccurrences).size < candidateOccurrences.length;
  return {
    processCount,
    counts,
    candidatePath,
    processTimes,
    isReentrant,
    processLabel: isReentrant ? "\u91CD\u5165\u7EC4" : processCount === 0 ? "\u65E0\u52A0\u5DE5\u5DE5\u5E8F" : `${processCount} \u9053\u5DE5\u5E8F`,
    label: isReentrant ? "\u91CD\u5165\u8DEF\u5F84" : processCount === 0 ? "(0)" : `(${counts.join(", ")})`,
    key: isReentrant ? "reentrant" : processCount === 0 ? "0:none" : `${processCount}:${counts.join(",")}`
  };
}
function formatSeconds(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${Number.isInteger(number) ? number : number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}s` : "\u672A\u8BBE\u7F6E";
}
function cleanNames(value) {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(rows.map((item) => String(item || "").trim()).filter(Boolean))];
}
function routeCleanSignature(route) {
  const parts = [];
  const append = (label, value) => {
    const names = cleanNames(value);
    if (names.length) parts.push(`${label}:${names.join("+")}`);
  };
  append("Pre", route.prePJobCleanRefs);
  append("Post", route.postPJobCleanRefs);
  append("CJob", route.postCJobCleanRefs);
  (route.stages || []).filter((stage) => stage.needProcess).forEach((stage, index) => {
    const before = [...new Set((stage.visits || []).flatMap((visit) => cleanNames(visit.beforeCleanRefs)))];
    const after = [...new Set((stage.visits || []).flatMap((visit) => cleanNames(visit.afterCleanRefs)))];
    append(`S${index + 1}\u524D`, before);
    append(`S${index + 1}\u540E`, after);
  });
  return parts.join(" \xB7 ");
}
function minimumResidencyConstraint(route) {
  const limits = (route.stages || []).filter((stage) => stage.needProcess).flatMap((stage) => stage.visits || []).map((visit) => Number(visit.residencyConstraint)).filter((limit) => Number.isFinite(limit) && limit >= 0);
  return limits.length ? Math.min(...limits) : null;
}
function automaticTemplateName(profile) {
  if (profile.processCount === 0) return "\u65E0\u52A0\u5DE5\u5DE5\u5E8F";
  return profile.candidatePath.join(" \u2192 ");
}
function automaticRouteName(profile, cleanSignature = "", minimumResidency = null) {
  const processName = profile.processCount === 0 ? "\u65E0\u52A0\u5DE5\u5DE5\u5E8F" : profile.candidatePath.map(
    (path, index) => `${path}(${formatSeconds(profile.processTimes[index])})`
  ).join(" \u2192 ");
  const suffixes = [
    cleanSignature,
    minimumResidency === null ? "" : `\u9A7B\u7559 ${formatSeconds(minimumResidency)}`
  ].filter(Boolean);
  return suffixes.length ? `${processName} \xB7 ${suffixes.join(" \xB7 ")}` : processName;
}
function compareProfiles(left, right) {
  if (left.processCount !== right.processCount) return left.processCount - right.processCount;
  for (let index = 0; index < Math.max(left.counts.length, right.counts.length); index += 1) {
    if ((left.counts[index] ?? -1) !== (right.counts[index] ?? -1)) {
      return (left.counts[index] ?? -1) - (right.counts[index] ?? -1);
    }
  }
  return 0;
}
function differenceFields(stage, normalizeVisit2 = (value) => value) {
  if ((stage.visits || []).length < 2) return [];
  const first = normalizeVisit2(stage.visits[0]);
  return VISIT_SHARED_FIELDS.filter((key) => stage.visits.slice(1).some(
    (visit) => JSON.stringify(normalizeVisit2(visit)[key]) !== JSON.stringify(first[key])
  ));
}
function synchronizeVisits(stage, normalizeVisit2 = (value) => value) {
  if (!(stage.visits || []).length) return;
  const parameters = cloneVisitParameters(normalizeVisit2(stage.visits[0]));
  stage.visits.forEach((visit) => Object.assign(visit, structuredClone(parameters)));
}
function replaceCandidates(stage, names, makeVisit2, normalizeVisit2 = (value) => value) {
  const selected = [...new Set((names || []).map((name) => String(name || "").trim()).filter(Boolean))];
  const prior = new Map((stage.visits || []).map((visit) => [visit.stationName, visit]));
  const template = stage.visits?.length ? cloneVisitParameters(normalizeVisit2(stage.visits[0])) : cloneVisitParameters(normalizeVisit2(makeVisit2("")));
  stage.visits = selected.map(
    (name) => prior.get(name) || { stationName: name, ...structuredClone(template) }
  );
}
function selectReferencedRoutes(routes, rounds) {
  const referencedNames = new Set((rounds || []).flatMap((round) => (round.cjobs || []).flatMap((cjob) => (cjob.pjobs || []).map((pjob) => String(pjob.routeRef || "").trim()))));
  return (routes || []).filter((route) => referencedNames.has(String(route.name || "").trim()));
}
function processRecipeName(value, fallback) {
  const explicitName = String(value ?? "").trim();
  return explicitName || String(fallback ?? "").trim();
}
function normalizeStageProcessRecipes(stage, recipeName, normalizeVisit2 = (value) => value) {
  const needsProcess = stage.needProcess === true;
  let changed = false;
  for (const visit of stage.visits || []) {
    normalizeVisit2(visit);
    const normalizedRecipe = needsProcess ? processRecipeName(visit.processRecipe, recipeName) : "";
    if (visit.processRecipe !== normalizedRecipe) {
      visit.processRecipe = normalizedRecipe;
      changed = true;
    }
    if (needsProcess) {
      const normalizedRecipeTime = Number(visit.processTime);
      if (visit.recipeTime !== normalizedRecipeTime) {
        visit.recipeTime = normalizedRecipeTime;
        changed = true;
      }
    }
  }
  return changed;
}

// src/api_client.ts
async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok || result?.ok === false) {
    throw new Error(result?.error || `\u670D\u52A1\u8FD4\u56DE ${response.status}`);
  }
  return result;
}
async function requestScheduleAnalysis(input) {
  const result = await requestJson("/api/analysis/schedule", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  return {
    analysis: result.analysis,
    bottleneck: result.bottleneck ?? null
  };
}
async function requestReplayDecision(input) {
  const result = await requestJson("/api/analysis/replay-decision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  return result.decision;
}
async function createTestGroupAnalysisJob(input) {
  const result = await requestJson("/api/analysis-jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  return result.job;
}
async function readTestGroupAnalysisJob(jobId) {
  const result = await requestJson(`/api/analysis-jobs/${encodeURIComponent(jobId)}`, {
    cache: "no-store"
  });
  return result.job;
}
async function cancelTestGroupAnalysisJob(jobId) {
  const result = await requestJson(`/api/analysis-jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST"
  });
  return result.job;
}
async function requestDeadlockDiagnostic(input) {
  const response = await fetch("/api/analysis/deadlock-diagnostic", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result?.error || `\u670D\u52A1\u8FD4\u56DE ${response.status}`);
  }
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const fallbackName = disposition.match(/filename="([^"]+)"/i)?.[1];
  return {
    blob: await response.blob(),
    fileName: encodedName ? decodeURIComponent(encodedName) : fallbackName || "deadlock-diagnostic.json"
  };
}
async function requestSearchControl(command, actionKey = null) {
  return requestJson("/api/search-control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(actionKey ? { command, actionKey } : { command })
  });
}

// src/topology_robot_mechanism.ts
var REST_REACH = 58;
var ATR_RETRACTED_REACH = 42;
var CLAW_SCALE = 0.8;
var ARM_SEPARATION = 44;
var CLAW_SEPARATION = 18;
var SHOULDER_SEPARATION = 16;
var EXTENDED_ELBOW_RATIO = 0.12;
var CLAW_STEM_OFFSET = 23;
var CLAW_PATH = "M -23 -4 L -15 -4 Q -8 -4 -7 -14 L 14 -20 L 16 -18 L -1 -12 Q -8 0 -1 12 L 16 18 L 14 20 L -7 14 Q -8 4 -15 4 L -23 4 Z";
var HANDOFF_PROGRESS = 0.5;
var SWAP_MOVE = 4;
function values(value) {
  return Array.isArray(value) ? value : [];
}
function configuredRobotArms(definition) {
  const arms = Object.entries(definition.ArmInfo ?? {}).filter(([, arm]) => arm && typeof arm === "object").map(([name, arm]) => ({
    name,
    enabled: arm.IsEnable !== false,
    slots: [...new Set(values(arm.SlotIDs).map(Number).filter((slot) => Number.isInteger(slot) && slot > 0))]
  }));
  if (arms.length) return arms;
  const declaredSlots = values(definition.Slots).map(Number).filter((slot) => Number.isInteger(slot) && slot > 0);
  const slots = declaredSlots.length ? declaredSlots : Array.from({ length: Math.max(1, Math.floor(Number(definition.Capacity) || 1)) }, (_, index) => index + 1);
  return slots.map((slot) => ({ name: `Arm${slot}`, enabled: true, slots: [slot] }));
}
function transferStages(move) {
  const type = Number(move.MoveType);
  const stage = (kind, slots, materials, stations, stationSlots) => values(move[materials]).map((wafer, index) => ({
    kind,
    wafer: String(wafer),
    robotSlot: Number(values(move[slots])[index] ?? 0),
    station: String(values(move[stations])[index] ?? values(move[stations])[0] ?? ""),
    stationSlot: Number(values(move[stationSlots])[index] ?? 0)
  }));
  if (type === SWAP_MOVE) {
    const pick = stage("pick", "RecvSlotList", "RecvMatList", "StationList", "StnSendSlotList");
    const place = stage("place", "SendSlotList", "SendMatList", "StationList", "StnRecvSlotList");
    return Number(move.SwapMode) === 1 ? [place, pick] : [pick, place];
  }
  if (type === 0 || type === 2) return [stage("pick", "RobotSlotList", "MatIDList", "SrcStationList", "SrcSlotList")];
  if (type === 1 || type === 3) return [stage("place", "RobotSlotList", "MatIDList", "DestStationList", "DestSlotList")];
  return [];
}
function robotSlotWafers(moves, time, name, heldWafers) {
  const byWafer = /* @__PURE__ */ new Map();
  const relevant = moves.filter((move) => move.ModuleName === name);
  for (const move of relevant) {
    for (const transfer of transferStages(move).flat()) {
      if (transfer.robotSlot > 0 && !byWafer.has(transfer.wafer)) byWafer.set(transfer.wafer, transfer.robotSlot);
    }
  }
  for (const move of [...relevant].sort((a, b) => Number(a.EndTime) - Number(b.EndTime))) {
    if (Number(move.EndTime) > time) continue;
    for (const transfer of transferStages(move).flat()) {
      if (transfer.kind === "pick" && transfer.robotSlot > 0) byWafer.set(transfer.wafer, transfer.robotSlot);
    }
  }
  return Object.fromEntries(heldWafers.filter((wafer) => byWafer.has(wafer)).map((wafer) => [byWafer.get(wafer), wafer]));
}
function robotArmAnimation(definitions, slotWafers, move, time) {
  const arms = definitions.map((arm) => ({
    ...arm,
    progress: null,
    target: "",
    wafers: Object.fromEntries(arm.slots.map((slot) => [slot, slotWafers[slot] ?? ""]))
  }));
  const transfers = [];
  if (!move) return { arms, transfers };
  const stages = transferStages(move);
  const duration = Number(move.EndTime) - Number(move.StartTime);
  const progress = duration > 0 ? Math.max(0, Math.min(1, (time - Number(move.StartTime)) / duration)) : 1;
  stages.forEach((stage, index) => {
    const localProgress = progress * stages.length - index;
    for (const transfer of stage) {
      const enabledSlots = arms.filter((arm2) => arm2.enabled).flatMap((arm2) => arm2.slots);
      const slot = transfer.robotSlot || (enabledSlots.length === 1 ? enabledSlots[0] : 0);
      const arm = arms.find((arm2) => arm2.enabled && arm2.slots.includes(slot));
      if (!arm) continue;
      if (localProgress >= 0 && localProgress < 1) {
        arm.progress = localProgress;
        arm.target = transfer.station;
      }
      if (localProgress >= HANDOFF_PROGRESS) {
        arm.wafers[slot] = transfer.kind === "pick" ? transfer.wafer : "";
        transfers.push({ ...transfer, robotSlot: slot });
      }
    }
  });
  return { arms, transfers };
}
function robotTransferReach(distance, progress, restReach = REST_REACH) {
  return restReach + (distance - restReach) * extensionFraction(progress);
}
function extensionFraction(progress) {
  if (progress === null) return 0;
  const bounded = Math.max(0, Math.min(1, progress));
  const phase = Math.min(1, bounded * 3, (1 - bounded) * 3);
  return phase * phase * (3 - 2 * phase);
}
function robotArmGeometry(reach, index, count, progress, targetSeparation = 0) {
  const side = index < (count - 1) / 2 ? -1 : 1;
  const shoulder = (index - (count - 1) / 2) * SHOULDER_SEPARATION;
  const fraction = extensionFraction(progress);
  const tipY = (index - (count - 1) / 2) * (ARM_SEPARATION * (1 - fraction) + targetSeparation * fraction);
  const bend = (1 - fraction) / 2 + fraction * EXTENDED_ELBOW_RATIO;
  return {
    shoulder,
    tipY,
    elbowX: reach / 2 - side * (tipY - shoulder) * bend,
    elbowY: (shoulder + tipY) / 2 + side * reach * bend
  };
}
function renderParallelRobotArms(arms, distance, renderWafer, escape, targetGeometry, occlusions = [], maskPrefix = "robot", mechanism = "articulated", stackedArms = false) {
  const waferLayers = [];
  const moving = arms.some((arm) => extensionFraction(arm.progress) > 0);
  const markup = arms.map((arm, index) => {
    const geometry = arm.target ? targetGeometry?.(arm.target) : void 0;
    const visibleProgress = targetGeometry && arm.target && !geometry ? null : arm.progress;
    const reach = robotTransferReach(
      geometry?.distance ?? distance,
      visibleProgress,
      mechanism === "telescopic" ? ATR_RETRACTED_REACH : REST_REACH
    );
    const { shoulder, elbowX, elbowY, tipY } = robotArmGeometry(reach, stackedArms ? 0 : index, stackedArms ? 1 : arms.length, visibleProgress);
    const verticalSlots = mechanism === "telescopic";
    const visibleSlots = verticalSlots ? arm.slots.slice(0, 1) : arm.slots;
    const faded = stackedArms && moving && !extensionFraction(visibleProgress);
    const hidden = stackedArms && !moving && index > 0;
    const clawSpacing = CLAW_SEPARATION;
    const branches = stackedArms ? visibleSlots.map((slot, slotIndex) => {
      const branchIndex = (geometry?.slotSpacing ?? 0) < 0 ? visibleSlots.length - 1 - slotIndex : slotIndex;
      const shape = robotArmGeometry(
        reach,
        branchIndex,
        visibleSlots.length,
        visibleProgress,
        Math.abs(geometry?.slotSpacing ?? ARM_SEPARATION)
      );
      const angle = Math.atan2(shape.tipY - shape.elbowY, reach - shape.elbowX);
      const mountX2 = reach - CLAW_STEM_OFFSET * CLAW_SCALE * Math.cos(angle);
      const mountY2 = shape.tipY - CLAW_STEM_OFFSET * CLAW_SCALE * Math.sin(angle);
      return { ...shape, slot, angle, path: `M 0 ${shape.shoulder} L ${shape.elbowX} ${shape.elbowY} L ${mountX2} ${mountY2}` };
    }) : [];
    const clawAngle = mechanism === "telescopic" || stackedArms ? 0 : Math.atan2(tipY - elbowY, reach - elbowX);
    const mountX = reach - CLAW_STEM_OFFSET * CLAW_SCALE * Math.cos(clawAngle);
    const mountY = tipY - CLAW_STEM_OFFSET * CLAW_SCALE * Math.sin(clawAngle);
    const linkPath = stackedArms ? branches.map((branch) => branch.path).join(" ") : mechanism === "telescopic" ? `M 0 ${tipY} L ${mountX} ${mountY}` : `M 0 ${shoulder} L ${elbowX} ${elbowY} L ${mountX} ${mountY}`;
    const wristHalfWidth = (visibleSlots.length - 1) * clawSpacing / 2;
    const wristPath = !stackedArms && visibleSlots.length > 1 ? ` M ${mountX} ${mountY - wristHalfWidth} V ${mountY + wristHalfWidth}` : "";
    const claws = visibleSlots.map((slot, slotIndex) => {
      const branch = branches[slotIndex];
      const y = branch?.tipY ?? tipY + (slotIndex - (visibleSlots.length - 1) / 2) * clawSpacing;
      return `<g class="parallel-robot-claw" data-robot-slot="${slot}" transform="translate(${reach} ${y}) rotate(${(branch?.angle ?? clawAngle) * 180 / Math.PI}) scale(${CLAW_SCALE})">
        <path d="${CLAW_PATH}"/>
      </g>`;
    }).join("");
    const waferSlots = verticalSlots ? arm.slots.filter((slot) => arm.wafers[slot]).slice(0, 1) : arm.slots;
    const wafers = waferSlots.map((slot, slotIndex) => {
      if (stackedArms && !moving && arms.slice(0, index).some((upper) => upper.wafers[upper.slots[slotIndex]])) return "";
      const wafer = arm.wafers[slot];
      const y = branches[slotIndex]?.tipY ?? tipY + (slotIndex - (waferSlots.length - 1) / 2) * clawSpacing;
      return wafer ? `<span class="parallel-robot-wafers" data-held-slot="${slot}" style="left:${reach}px;top:${y}px">${renderWafer(wafer)}</span>` : "";
    }).join("");
    const localAngle = geometry?.angle ?? 0;
    waferLayers.push(`<div class="parallel-robot-wafer-layer" style="--robot-arm-local-angle:${localAngle}deg;opacity:${faded ? 0.3 : 1}">${wafers}</div>`);
    const maskId = `robot-mask-${Array.from(maskPrefix).map((character) => character.codePointAt(0)).join("-")}-${index}`;
    const radians = localAngle * Math.PI / 180;
    const holes = occlusions.map((point) => `<circle cx="${point.x * Math.cos(radians) + point.y * Math.sin(radians)}" cy="${-point.x * Math.sin(radians) + point.y * Math.cos(radians)}" r="${point.radius}" fill="black"/>`).join("");
    return `<div class="parallel-robot-arm${arm.progress === null ? "" : " is-transferring"}${arm.enabled ? "" : " is-disabled"}" data-arm="${escape(arm.name)}" style="--robot-reach:${reach.toFixed(2)}px;--robot-arm-local-angle:${localAngle}deg;${hidden ? "visibility:hidden;" : faded ? "opacity:.3;" : ""}">
      <svg class="parallel-robot-arms" overflow="visible" aria-hidden="true">
        <defs><mask id="${maskId}" maskUnits="userSpaceOnUse" x="-2000" y="-2000" width="4000" height="4000"><rect x="-2000" y="-2000" width="4000" height="4000" fill="white"/>${holes}</mask></defs>
        <g mask="url(#${maskId})"><path class="parallel-robot-link" d="${linkPath}${wristPath}"/>
        <path class="parallel-robot-link-inset" d="${linkPath}${wristPath}"/>
        ${mechanism === "telescopic" ? `<path class="parallel-robot-slide" d="M 0 ${tipY} H ${reach / 2}"/>` : stackedArms ? branches.map((branch) => `<circle class="parallel-robot-joint" cx="${branch.elbowX}" cy="${branch.elbowY}" r="4"/>`).join("") : `<circle class="parallel-robot-joint" cx="${elbowX}" cy="${elbowY}" r="4"/>`}${claws}</g>
      </svg></div>`;
  }).join("");
  return `<div class="parallel-robot-mechanism">${markup}${waferLayers.join("")}</div>`;
}

// src/topology_transfer_projection.ts
function projectTopologyTransfers(snapshot, device) {
  const modules = snapshot.modules.map((module) => ({
    ...module,
    wafers: [...module.wafers],
    processedWafers: [...module.processedWafers],
    loadPortSlots: module.loadPortSlots.map((slot) => ({ ...slot })),
    loadLockSlots: module.loadLockSlots.map((slot) => ({ ...slot })),
    processSlots: module.processSlots?.map((slot) => ({ ...slot }))
  }));
  const animations = /* @__PURE__ */ new Map();
  for (const robot of snapshot.robots) {
    const definition = device?.Robots?.[robot.name];
    const arms = definition ? configuredRobotArms(definition) : robot.arms ?? configuredRobotArms({ Capacity: robot.capacity });
    const slots = arms.flatMap((arm) => arm.slots);
    const slotWafers = { ...robot.slotWafers };
    if (slots.length === 1 && robot.wafers.length === 1 && !Object.keys(slotWafers).length) {
      slotWafers[slots[0]] = robot.wafers[0];
    }
    const move = snapshot.activeMoves.find((move2) => move2.ModuleName === robot.name);
    const preparation = robot.environment === "atmosphere" ? robot.railMotion?.preparationFraction ?? 0 : 0;
    const alignedMove = move && preparation ? {
      ...move,
      StartTime: Number(move.StartTime) + (Number(move.EndTime) - Number(move.StartTime)) * preparation
    } : move;
    const animation = robotArmAnimation(
      arms,
      slotWafers,
      alignedMove && snapshot.time < Number(alignedMove.StartTime) ? void 0 : alignedMove,
      snapshot.time
    );
    animations.set(robot.name, animation.arms);
    for (const transfer of animation.transfers) {
      const module = modules.find((module2) => module2.name === transfer.station);
      if (!module) continue;
      const processed = robot.processedWafers.includes(transfer.wafer);
      if (transfer.kind === "pick") {
        module.wafers = module.wafers.filter((wafer) => wafer !== transfer.wafer);
      } else if (!module.wafers.includes(transfer.wafer)) {
        module.wafers.push(transfer.wafer);
        if (processed) module.processedWafers.push(transfer.wafer);
      }
      for (const slot of [...module.loadPortSlots, ...module.loadLockSlots, ...module.processSlots ?? []]) {
        if (transfer.kind === "pick" && slot.wafer === transfer.wafer) {
          slot.wafer = "";
          slot.processed = false;
        } else if (transfer.kind === "place" && slot.slot === transfer.stationSlot) {
          slot.wafer = transfer.wafer;
          slot.processed = processed;
        }
      }
    }
  }
  return { modules, animations };
}

// src/topology_loadlock_doors.ts
var PREPARE = 6;
var COMPLETE = 7;
var TRANSFERS = /* @__PURE__ */ new Set([0, 1, 2, 3, 4]);
var TIME_TOLERANCE = 1e-6;
var RELATED_ATMOSPHERE = 0;
var RELATED_VACUUM = 1;
function values2(value) {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}
function robotKind(name, device) {
  const type = String(device?.Robots?.[name]?.Type ?? "");
  if (/HighVTM/i.test(type) || /VTR[_-]?2/i.test(name)) return "upper";
  if (/ATM/i.test(type) || /ATR|ATM/i.test(name)) return "atmosphere";
  if (/VTM|VAC/i.test(type) || /VTR|VAC/i.test(name)) return "vacuum";
  return void 0;
}
function indexTransfers(moves) {
  const index = { byId: /* @__PURE__ */ new Map(), dependents: /* @__PURE__ */ new Map(), starts: /* @__PURE__ */ new Map(), ends: /* @__PURE__ */ new Map() };
  const append = (map, key, move) => {
    const entries = map.get(key) ?? [];
    entries.push(move);
    map.set(key, entries);
  };
  for (const move of moves) {
    if (!TRANSFERS.has(Number(move.MoveType))) continue;
    if (move.MoveID !== void 0) index.byId.set(move.MoveID, move);
    for (const id of values2(move.PreMoveID)) append(index.dependents, Number(id), move);
    const stations = new Set([...values2(move.SrcStationList), ...values2(move.DestStationList), ...values2(move.StationList)].map(String));
    for (const station2 of stations) {
      append(index.starts, `${station2}:${Math.round(Number(move.StartTime) / TIME_TOLERANCE)}`, move);
      append(index.ends, `${station2}:${Math.round(Number(move.EndTime) / TIME_TOLERANCE)}`, move);
    }
  }
  return index;
}
function relatedRobot(door, index) {
  const explicit = String(door.Robot ?? "");
  if (explicit) return explicit;
  const closing = door.MoveType === COMPLETE;
  const boundary = Number(closing ? door.StartTime : door.EndTime);
  const bucket = Math.round(boundary / TIME_TOLERANCE);
  const dependencies = closing ? values2(door.PreMoveID).map((id) => index.byId.get(Number(id))).filter((move) => Boolean(move)) : index.dependents.get(Number(door.MoveID)) ?? [];
  const adjacent = [-1, 0, 1].flatMap((offset) => (closing ? index.ends : index.starts).get(`${door.ModuleName}:${bucket + offset}`) ?? []);
  const matches = (move) => {
    const stations = [...values2(move.SrcStationList), ...values2(move.DestStationList), ...values2(move.StationList)];
    if (!stations.map(String).includes(String(door.ModuleName))) return false;
    const materials = values2(door.MatIDList).map(String);
    const transported = values2(move.MatIDList).map(String);
    return !materials.length || !transported.length || materials.some((material) => transported.includes(material));
  };
  const related = dependencies.filter(matches);
  const selected = related.length ? related : adjacent.filter((move) => matches(move) && Math.abs(Number(closing ? move.EndTime : move.StartTime) - boundary) <= TIME_TOLERANCE);
  const robots = [...new Set(selected.map((move) => String(move.Robot || move.ModuleName || "")).filter(Boolean))];
  return robots.length === 1 ? robots[0] : void 0;
}
function projectLoadLockDoors(moves, device, time, names) {
  const result = /* @__PURE__ */ new Map();
  const transfers = indexTransfers(moves);
  for (const name of names) {
    const station2 = device?.Stations?.[name];
    const preparations = values2(station2?.PrePrepareTime);
    const linkedNames = preparations.flatMap((item) => [String(item.LastItem ?? ""), String(item.CurrentItem ?? "")]);
    const bridge = linkedNames.some((robot) => robotKind(robot, device) === "upper") || /^(UBR|DBR)$/i.test(name);
    const doors = { top: "closed", bottom: "closed", topLabel: bridge ? "\u4E0A\u7EA7\u771F\u7A7A\u4FA7" : "\u771F\u7A7A\u4FA7", bottomLabel: bridge ? "\u4E0B\u7EA7\u771F\u7A7A\u4FA7" : "\u5927\u6C14\u4FA7" };
    const sideForRobot = (robot) => {
      const kind = robotKind(robot, device);
      if (bridge) return kind === "upper" ? "top" : kind === "vacuum" ? "bottom" : void 0;
      return kind === "atmosphere" ? "bottom" : kind === "vacuum" || kind === "upper" ? "top" : void 0;
    };
    let previousSide;
    let environmentRobot = String(station2?.LastItem ?? "");
    for (const move of moves) {
      if (move.ModuleName !== name || Number(move.StartTime) > time) continue;
      if (move.MoveType === 10 && Number(move.EndTime) <= time) environmentRobot = String(move.CurState ?? "");
      if (move.MoveType !== PREPARE && move.MoveType !== COMPLETE) continue;
      const robot = relatedRobot(move, transfers);
      let side = robot ? sideForRobot(robot) : void 0;
      if (!side && move.MoveType === COMPLETE) side = previousSide;
      if (!side && !bridge) side = move.RelatedRobotType === RELATED_ATMOSPHERE ? "bottom" : move.RelatedRobotType === RELATED_VACUUM ? "top" : void 0;
      if (!side) side = sideForRobot(environmentRobot);
      const completed = Number(move.EndTime) <= time;
      if (side) {
        doors[side] = move.MoveType === PREPARE ? completed ? "open" : "opening" : completed ? "closed" : "closing";
        previousSide = side;
      } else {
        doors.top = doors.bottom = move.MoveType === COMPLETE && completed ? "closed" : "unknown";
      }
    }
    result.set(name, doors);
  }
  return result;
}

// src/topology_atmosphere_rail.ts
var PRE_TRANS_MOVE = 5;
var RAIL_PREPARATION_FRACTION = 0.25;
function station(move, field) {
  return Array.isArray(move[field]) ? String(move[field][0] ?? "") : "";
}
function atmosphereRailMotion(moves, robot, time) {
  let previousTarget = "";
  for (const move of moves.filter((move2) => move2.ModuleName === robot).sort((left, right) => Number(left.StartTime) - Number(right.StartTime))) {
    if (Number(move.StartTime) > time) break;
    const target = station(move, "DestStationList") || station(move, "SrcStationList") || station(move, "StationList");
    if (!target) continue;
    if (Number(move.EndTime) > time) {
      const source = Number(move.MoveType) === PRE_TRANS_MOVE ? station(move, "SrcStationList") || previousTarget : previousTarget;
      const preparationFraction = Number(move.MoveType) < PRE_TRANS_MOVE && source !== target ? RAIL_PREPARATION_FRACTION : 0;
      const progress = (time - Number(move.StartTime)) / (Number(move.EndTime) - Number(move.StartTime));
      return {
        source,
        target,
        preparationFraction,
        progress: Number(move.MoveType) === PRE_TRANS_MOVE ? progress : preparationFraction ? Math.min(1, progress / preparationFraction) : 1
      };
    }
    previousTarget = target;
  }
  return { source: previousTarget, target: previousTarget, progress: 1, preparationFraction: 0 };
}

// src/topology_robot_slots.ts
function renderRobotSlotRow(robot, dual, renderSlots, escape) {
  const arms = robot.arms ?? configuredRobotArms({ Capacity: robot.capacity });
  const combined = dual && robot.environment === "vacuum";
  const slots = (ids) => ids.map((slot) => ({
    slot,
    wafer: robot.slotWafers?.[slot] ?? "",
    processed: robot.processedWafers.includes(robot.slotWafers?.[slot] ?? "")
  }));
  const boards = combined ? `<div class="front-module front-robot-combined"><strong>${escape(robot.name)}</strong><div class="front-slot-board front-robot-combined-board" style="--front-slot-count:${arms.length}">${arms.map((arm) => `<div class="front-robot-arm-pair" role="group" aria-label="${escape(arm.name)}">${renderSlots(slots(arm.slots))}</div>`).join("")}</div></div>` : arms.map((arm) => `<div class="front-module"><strong>${escape(robot.name)}${dual ? "" : ` \xB7 ${escape(arm.name)}`}</strong><div class="front-slot-board" style="--front-slot-count:${arm.slots.length}" role="group" aria-label="${escape(robot.name + " " + arm.name)}">${renderSlots(slots(arm.slots))}</div></div>`).join("");
  return `<div class="front-slot-row front-slot-row-robot" data-robot="${escape(robot.name)}">${boards}</div>`;
}

// src/workspace_visualizer.ts
var ALL_ACTION_DIAGNOSTIC_STATUSES = [
  "enabled",
  "physical-blocked",
  "deadlock-blocked"
];
var PICK_MOVE_TYPES = /* @__PURE__ */ new Set([0, 2]);
var PLACE_MOVE_TYPES = /* @__PURE__ */ new Set([1, 3]);
var SWAP_MOVE2 = 4;
var DECISION_COMPLETION_MOVE_TYPES = /* @__PURE__ */ new Set([...PLACE_MOVE_TYPES, SWAP_MOVE2]);
var PRIMITIVE_DECISION_COMPLETION_MOVE_TYPES = /* @__PURE__ */ new Set([
  ...PICK_MOVE_TYPES,
  ...PLACE_MOVE_TYPES,
  SWAP_MOVE2
]);
var PRE_TRANS_MOVE2 = 5;
var PREPARE_MOVE = 6;
var COMPLETE_MOVE = 7;
var PROCESS_MOVE = 9;
var PRE_PREPARE_MOVE = 10;
var PUMP_MOVE = 12;
var VENT_MOVE = 13;
var CLEAN_MOVE = 14;
var LOADLOCK_ENVIRONMENT_MOVE_TYPES = /* @__PURE__ */ new Set([PRE_PREPARE_MOVE, PUMP_MOVE, VENT_MOVE]);
var PLAYBACK_FRAME_INTERVAL_MS = 40;
var DEFAULT_PLAYBACK_SPEED = 4;
var PERFORMANCE_DISPLAY_TOLERANCE = 1e-6;
var DEFAULT_LOAD_PORT_CAPACITY = 25;
var ACTIVITY_CATEGORIES = [
  "process",
  "clean",
  "door",
  "transfer",
  "environment",
  "other"
];
var ACTIVITY_CATEGORY_LABELS = {
  process: "\u52A0\u5DE5",
  clean: "\u6E05\u6D01",
  door: "\u5F00\u5173\u95E8",
  transfer: "\u53D6\u653E / \u642C\u8FD0",
  environment: "\u62BD\u5145\u6C14",
  other: "\u5176\u4ED6"
};
var MOVE_NAMES = {
  0: "\u53D6\u7247",
  1: "\u653E\u7247",
  2: "\u591A\u7247\u53D6\u7247",
  3: "\u591A\u7247\u653E\u7247",
  4: "\u6362\u7247",
  5: "\u673A\u68B0\u624B\u8F6C\u4F4D",
  6: "\u5F00\u95E8",
  7: "\u5173\u95E8",
  8: "\u540E\u7F6E\u5B8C\u6210",
  9: "\u52A0\u5DE5",
  10: "\u73AF\u5883\u5207\u6362",
  11: "\u5BF9\u51C6",
  12: "\u62BD\u771F\u7A7A",
  13: "\u5145\u6C14",
  14: "\u6E05\u6D01"
};
var STATUS_LABELS = {
  idle: "\u7A7A\u95F2",
  occupied: "\u5DF2\u8F7D\u7247",
  door: "\u95E8\u52A8\u4F5C",
  transfer: "\u4F20\u8F93\u4E2D",
  processing: "\u52A0\u5DE5\u4E2D",
  cleaning: "\u6E05\u6D01\u4E2D",
  environment: "\u73AF\u5883\u5207\u6362"
};
var DOOR_LABELS = {
  closed: "\u95E8\u5DF2\u5173\u95ED",
  opening: "\u6B63\u5728\u5F00\u95E8",
  open: "\u95E8\u5DF2\u6253\u5F00",
  closing: "\u6B63\u5728\u5173\u95E8",
  doorless: "\u65E0\u95E8\u7ED3\u6784"
};
function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
function nullableFiniteNumber(value) {
  if (value === null || value === void 0 || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function listValue(value) {
  return Array.isArray(value) ? value : [];
}
function normalizeMovePayload(payload) {
  const records = Array.isArray(payload) ? payload : payload && typeof payload === "object" && Array.isArray(payload.MoveList) ? payload.MoveList : null;
  if (!records) throw new Error("\u6587\u4EF6\u5FC5\u987B\u662F MoveList \u6570\u7EC4\uFF0C\u6216\u5305\u542B MoveList \u5B57\u6BB5\u7684 JSON \u5BF9\u8C61");
  return records.filter((record) => Boolean(record) && typeof record === "object" && !Array.isArray(record)).map((record) => ({ ...record }));
}
function normalizeDecisionCandidate(candidate, actor = "") {
  return {
    actionId: String(candidate.actionId ?? ""),
    actor: String(candidate.actor ?? actor),
    kind: String(candidate.kind ?? ""),
    flowKind: String(candidate.flowKind ?? candidate.kind ?? ""),
    robot: String(candidate.robot ?? ""),
    materialIds: listValue(candidate.materialIds).map(String),
    waferId: finiteNumber(candidate.waferId),
    stageIndex: finiteNumber(candidate.stageIndex),
    source: String(candidate.source ?? ""),
    sourceSlot: finiteNumber(candidate.sourceSlot),
    destination: String(candidate.destination ?? ""),
    destinationSlot: finiteNumber(candidate.destinationSlot),
    earliestStart: finiteNumber(candidate.earliestStart),
    finishTime: finiteNumber(candidate.finishTime),
    rank: finiteNumber(candidate.rank),
    selected: Boolean(candidate.selected),
    executed: Boolean(candidate.executed),
    priorityDeferred: Boolean(candidate.priorityDeferred),
    policyScore: finiteNumber(candidate.policyScore),
    policyPreference: Math.max(0, Math.min(1, finiteNumber(candidate.policyPreference))),
    expectedRemainingMakespan: nullableFiniteNumber(candidate.expectedRemainingMakespan),
    expectedRemainingCost: nullableFiniteNumber(candidate.expectedRemainingCost),
    medianRemainingMakespan: nullableFiniteNumber(candidate.medianRemainingMakespan),
    lowerRemainingMakespan: nullableFiniteNumber(candidate.lowerRemainingMakespan),
    upperRemainingMakespan: nullableFiniteNumber(candidate.upperRemainingMakespan),
    makespanDelta: nullableFiniteNumber(candidate.makespanDelta)
  };
}
function normalizeReplayActionDiagnostic(value) {
  const kind = String(value.kind ?? "").toLowerCase();
  const status = String(value.status ?? "").toLowerCase();
  if (!["pick", "place", "swap"].includes(kind)) return null;
  if (!["enabled", "physical-blocked", "deadlock-blocked"].includes(status)) return null;
  return {
    actionId: String(value.actionId ?? ""),
    kind,
    status,
    reason: String(value.reason ?? ""),
    actor: String(value.actor ?? ""),
    robot: String(value.robot ?? ""),
    materialIds: listValue(value.materialIds).map(String),
    source: String(value.source ?? ""),
    sourceSlot: finiteNumber(value.sourceSlot),
    destination: String(value.destination ?? ""),
    destinationSlot: finiteNumber(value.destinationSlot),
    duplicateCount: Math.max(0, Math.round(finiteNumber(value.duplicateCount))),
    earliestStart: finiteNumber(value.earliestStart),
    finishTime: finiteNumber(value.finishTime)
  };
}
function normalizeDecisionTrace(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const record = payload;
  const rawTrace = record.DecisionTrace;
  if (!Array.isArray(rawTrace)) return [];
  const traceMeta = record.DecisionTraceMeta;
  const meta = traceMeta && typeof traceMeta === "object" && !Array.isArray(traceMeta) ? traceMeta : {};
  return rawTrace.filter((step) => Boolean(step) && typeof step === "object" && !Array.isArray(step)).map((step) => {
    const modelSignature = `${String(step.model ?? "")} ${String(meta.schema ?? "")} ${String(meta.model ?? "")}`.toLowerCase();
    const model = modelSignature.includes("actions") ? "actions" : modelSignature.includes("dual-actor") || modelSignature.includes("\u53CC actor") ? "dual-actor-e2e" : "e2e-ctq";
    const rawCandidates = Array.isArray(step.candidates) ? step.candidates : model === "dual-actor-e2e" && Array.isArray(step.proposals) ? step.proposals : [];
    let candidates = rawCandidates.filter((candidate) => Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate)).map((candidate) => normalizeDecisionCandidate(candidate)).sort((left, right) => left.rank - right.rank || right.policyPreference - left.policyPreference);
    const rawGroups = Array.isArray(step.candidateGroups) ? step.candidateGroups : [];
    let candidateGroups = rawGroups.filter((group) => Boolean(group) && typeof group === "object" && !Array.isArray(group)).map((group) => {
      const actor = String(group.actor ?? "");
      const groupCandidates = listValue(group.candidates).filter((candidate) => Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate)).map((candidate) => normalizeDecisionCandidate(candidate, actor)).sort((left, right) => left.rank - right.rank || right.policyPreference - left.policyPreference).map((candidate, index, rows) => ({
        ...candidate,
        rank: candidate.rank || index + 1,
        policyPreference: rows.length === 1 && candidate.policyPreference === 0 ? 1 : candidate.policyPreference
      }));
      return {
        actor,
        label: String(group.label ?? (actor === "atmosphere" ? "\u5927\u6C14\u7AEF Actor" : "\u771F\u7A7A\u7AEF Actor")),
        selectedActionId: String(group.selectedActionId ?? ""),
        executedActionId: String(group.executedActionId ?? ""),
        candidateCount: Math.max(groupCandidates.length, finiteNumber(group.candidateCount, groupCandidates.length)),
        shownCandidateCount: Math.max(groupCandidates.length, finiteNumber(group.shownCandidateCount, groupCandidates.length)),
        candidatesTruncated: Boolean(group.candidatesTruncated),
        candidates: groupCandidates
      };
    });
    if (model === "dual-actor-e2e" && !candidateGroups.length && candidates.length) {
      candidateGroups = ["atmosphere", "vacuum"].map((actor) => {
        const groupCandidates = candidates.filter((candidate) => candidate.actor === actor).map((candidate, index, rows) => ({
          ...candidate,
          rank: candidate.rank || index + 1,
          policyPreference: rows.length === 1 && candidate.policyPreference === 0 ? 1 : candidate.policyPreference
        }));
        return {
          actor,
          label: actor === "atmosphere" ? "\u5927\u6C14\u7AEF Actor" : "\u771F\u7A7A\u7AEF Actor",
          selectedActionId: groupCandidates.find((candidate) => candidate.selected)?.actionId ?? "",
          executedActionId: groupCandidates.find((candidate) => candidate.executed)?.actionId ?? "",
          candidateCount: groupCandidates.length,
          shownCandidateCount: groupCandidates.length,
          candidatesTruncated: false,
          candidates: groupCandidates
        };
      }).filter((group) => group.candidates.length);
    }
    if (candidateGroups.length) candidates = candidateGroups.flatMap((group) => group.candidates);
    const actionDiagnostics = listValue(step.actionDiagnostics).filter((action) => Boolean(action) && typeof action === "object" && !Array.isArray(action)).map(normalizeReplayActionDiagnostic).filter((action) => Boolean(action));
    const rawActionCounts = step.actionCounts && typeof step.actionCounts === "object" ? step.actionCounts : {};
    return {
      model,
      modelLabel: String(step.modelLabel ?? (model === "dual-actor-e2e" ? "\u53CC Actor \u539F\u5B50\u8C03\u5EA6" : "E2E-CTQ")),
      decisionIndex: finiteNumber(step.decisionIndex),
      time: finiteNumber(step.time),
      revision: finiteNumber(step.revision),
      roundIndex: finiteNumber(step.roundIndex),
      roundKind: String(step.roundKind ?? ""),
      selectedActionId: String(step.selectedActionId ?? ""),
      executedActionId: String(step.executedActionId ?? ""),
      candidateCount: Math.max(candidates.length, finiteNumber(step.candidateCount, candidates.length)),
      shownCandidateCount: Math.max(candidates.length, finiteNumber(step.shownCandidateCount, candidates.length)),
      candidatesTruncated: Boolean(step.candidatesTruncated),
      modelEvaluated: Boolean(step.modelEvaluated),
      replayEvaluated: Boolean(step.replayEvaluated),
      candidates,
      candidateGroups,
      actionDiagnosticsSource: String(step.actionDiagnosticsSource ?? ""),
      actionDiagnosticsProvider: String(step.actionDiagnosticsProvider ?? ""),
      actionCounts: {
        enabled: finiteNumber(rawActionCounts.enabled),
        "physical-blocked": finiteNumber(rawActionCounts["physical-blocked"]),
        "deadlock-blocked": finiteNumber(rawActionCounts["deadlock-blocked"])
      },
      actionDiagnostics
    };
  }).sort((left, right) => left.time - right.time || left.decisionIndex - right.decisionIndex);
}
function naturalCompare(left, right) {
  return left.localeCompare(right, void 0, { numeric: true, sensitivity: "base" });
}
function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function formatSeconds2(value) {
  return Number.isFinite(value) ? value.toFixed(1) : "0.0";
}
function materialIds(move, field = "MatIDList") {
  return listValue(move[field]).map(String).filter(Boolean);
}
function normalizeLoadPortReplenishments(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const replayContext = payload.ReplayContext;
  if (!replayContext || typeof replayContext !== "object" || Array.isArray(replayContext)) return [];
  const updates = listValue(replayContext.updates).filter((update) => Boolean(update) && typeof update === "object" && !Array.isArray(update)).sort((left, right) => finiteNumber(left.CurrentTime) - finiteNumber(right.CurrentTime));
  const knownTaskIdsByPort = /* @__PURE__ */ new Map();
  const replenishments = [];
  updates.forEach((update, updateIndex) => {
    const materials = listValue(update.Materials).filter((material) => Boolean(material) && typeof material === "object" && !Array.isArray(material));
    const currentByPortAndTask = /* @__PURE__ */ new Map();
    for (const material of materials) {
      const port = String(material.SrcPortName ?? "").trim();
      const currentModule = String(material.CurrentModuleName ?? "").trim();
      const taskId = String(material.TaskID ?? "").trim();
      const wafer = String(material.ID ?? material.Name ?? "").trim();
      const slot = Math.trunc(finiteNumber(material.SlotID));
      if (!port || currentModule !== port || !taskId || !wafer || slot < 1) continue;
      const byTask = currentByPortAndTask.get(port) ?? /* @__PURE__ */ new Map();
      const taskMaterials = byTask.get(taskId) ?? [];
      taskMaterials.push({ wafer, slot, taskId });
      byTask.set(taskId, taskMaterials);
      currentByPortAndTask.set(port, byTask);
    }
    for (const [port, byTask] of currentByPortAndTask) {
      const knownTaskIds = knownTaskIdsByPort.get(port) ?? /* @__PURE__ */ new Set();
      for (const [taskId, taskMaterials] of byTask) {
        if (updateIndex > 0 && !knownTaskIds.has(taskId)) {
          replenishments.push({
            time: finiteNumber(update.CurrentTime),
            moduleName: port,
            materials: taskMaterials.sort((left, right) => left.slot - right.slot)
          });
        }
        knownTaskIds.add(taskId);
      }
      knownTaskIdsByPort.set(port, knownTaskIds);
    }
  });
  return replenishments;
}
function materialInstanceId(move, material, index) {
  const taskIds = listValue(move.TaskID).map(String).filter(Boolean);
  const taskId = taskIds[index] ?? taskIds[0] ?? "";
  if (taskId) return `${material}\0${taskId}`;
  const processJobs = listValue(move.PJobName).map(String).filter(Boolean);
  const processJob = processJobs[index] ?? processJobs[0] ?? "";
  return processJob ? `${material}\0${processJob}` : material;
}
function isCleaningMove(move) {
  if (move.MoveType === CLEAN_MOVE) return true;
  if (move.MoveType !== PROCESS_MOVE) return false;
  const materialList = move.MatIDList;
  const explicitlyEmpty = Array.isArray(materialList) && materialList.length === 0;
  const cleanMetadata = [move.CleanRecipe, move.CleanTaskName, move.RecipeName, move.ProcessRecipe].some((value) => /clean|wac|dummy/i.test(String(value ?? "")));
  return explicitlyEmpty || cleanMetadata;
}
function firstStation(move, field) {
  return String(listValue(move[field])[0] ?? "");
}
function isRobotName(name, configuredRobotNames) {
  return Boolean(configuredRobotNames?.has(name)) || /^(ATR|VTR|ATM|VTM|VAC|TM\d*|ROBOT)/i.test(name);
}
function robotEnvironment(name, definition = {}) {
  const type = String(definition.Type ?? "");
  if (/ATM|ATR|大气/i.test(type) || /^(ATR|ATM)/i.test(name)) return "atmosphere";
  return "vacuum";
}
function robotCapacity(definition, holdingCount = 0) {
  const declaredCapacity = finiteNumber(definition.Capacity, 0);
  const armSlotCount = Object.values(definition.ArmInfo ?? {}).reduce((maximum, arm) => {
    if (!arm || typeof arm !== "object") return maximum;
    return Math.max(maximum, listValue(arm.SlotIDs).length);
  }, 0);
  return Math.max(1, declaredCapacity, armSlotCount, holdingCount);
}
function isDummyPortName(name) {
  return /DUMMY/i.test(name) && /PORT/i.test(name);
}
function splitWaferOrigin(origin) {
  const trimmed = origin.trim();
  const separator = trimmed.lastIndexOf(".");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return { moduleName: trimmed, slotLabel: "" };
  }
  return {
    moduleName: trimmed.slice(0, separator),
    slotLabel: trimmed.slice(separator + 1)
  };
}
function isDummyWaferOrigin(origin) {
  const { moduleName } = splitWaferOrigin(origin);
  return Boolean(moduleName) && isDummyPortName(moduleName);
}
var DUMMY_MATERIAL_ID_START = 1e5;
function isDummyWafer(wafer, origin) {
  if (isDummyWaferOrigin(origin)) return true;
  const materialId = Number(wafer);
  return Number.isInteger(materialId) && materialId >= DUMMY_MATERIAL_ID_START;
}
function waferSurfaceLabel(wafer, origin) {
  if (isDummyWafer(wafer, origin) && wafer) return wafer;
  if (!origin) return "\u6765\u6E90\u672A\u77E5";
  return origin;
}
function isBufferModule(name, type = "") {
  return type.trim().toLowerCase() === "buffer" || /^BUF(?:FER)?(?:[_-]?\w+)?$/i.test(name.trim());
}
function isCoolerModule(name, type = "") {
  return type.trim().toLowerCase() === "cooler" || /^(CL|COOL(?:ER)?)$/i.test(name.trim());
}
function isAlignerModule(name, type = "") {
  return type.trim().toLowerCase() === "aligner" || /^(AL|ALIGNER)$/i.test(name.trim());
}
function isHeaterModule(name, type = "") {
  return type.trim().toLowerCase() === "heater" || /^HEATER$/i.test(name.trim());
}
function isTopologyHiddenModule(module) {
  const name = module.name.trim();
  const type = module.type.trim().toLowerCase();
  return isBufferModule(name, type) || /^LP4$/i.test(name);
}
function isLoadPortName(name, type = "") {
  const normalizedType = type.trim().toLowerCase();
  return normalizedType === "loadport" || normalizedType === "dummyport" || isDummyPortName(name) || /^(LP\d*|P\d+|.*PORT)$/i.test(name);
}
function isLoadLockName(name, type = "") {
  return !isBufferModule(name, type) && (type.toLowerCase() === "loadlock" || /^LL?[A-Z]$/i.test(name));
}
function initialLoadLockEnvironment(device, name) {
  const lastItem = String(device?.Stations?.[name]?.LastItem ?? "");
  if (/VTR|VAC|真空/i.test(lastItem)) return "\u771F\u7A7A";
  if (/ATR|ATM|大气/i.test(lastItem)) return "\u5927\u6C14";
  return "\u5927\u6C14";
}
function isDoorlessModule(name, type = "") {
  return isCoolerModule(name, type) || isBufferModule(name, type);
}
function isProcessModule(name, type = "") {
  const normalizedType = type.toLowerCase();
  return /process|chamber/.test(normalizedType) || /^(PM|CH)\w*/i.test(name);
}
function normalizeMoves(moves) {
  return moves.map((move, index) => {
    const startTime = finiteNumber(move.StartTime);
    const endTime = Math.max(startTime, finiteNumber(move.EndTime, startTime));
    return {
      ...move,
      MoveID: finiteNumber(move.MoveID, index + 1),
      MoveType: finiteNumber(move.MoveType, -1),
      ModuleName: String(move.ModuleName ?? ""),
      StartTime: startTime,
      EndTime: endTime
    };
  }).sort((left, right) => left.StartTime - right.StartTime || left.EndTime - right.EndTime || left.MoveID - right.MoveID);
}
function collectModuleDefinitions(moves, device, configuredRobotNames = /* @__PURE__ */ new Set()) {
  const modules = /* @__PURE__ */ new Map();
  const stationDefinitions = device?.Stations ?? {};
  const hasConfiguredStations = Object.keys(stationDefinitions).length > 0;
  for (const move of moves) {
    const candidates = [
      move.ModuleName,
      ...listValue(move.SrcStationList),
      ...listValue(move.DestStationList),
      ...listValue(move.StationList)
    ].map(String).filter(Boolean);
    for (const name of candidates) {
      if (hasConfiguredStations && !stationDefinitions[name]) continue;
      if (!isRobotName(name, configuredRobotNames) && !modules.has(name)) {
        modules.set(name, { type: String(stationDefinitions[name]?.Type ?? "") });
      }
    }
  }
  return modules;
}
function collectRobotNames(moves, device) {
  const configuredRobotNames = new Set(Object.keys(device?.Robots ?? {}));
  const names = new Set(configuredRobotNames);
  for (const move of moves) {
    if (isRobotName(move.ModuleName, configuredRobotNames)) names.add(move.ModuleName);
    const robot = String(move.Robot ?? "");
    if (robot) names.add(robot);
  }
  return [...names].sort(naturalCompare);
}
function initialMaterialLocations(moves) {
  const locations = /* @__PURE__ */ new Map();
  for (const move of moves) {
    if (move.MoveType === SWAP_MOVE2) {
      const station2 = String(listValue(move.StationList)[0] ?? "");
      for (const material of materialIds(move, "RecvMatList")) {
        if (!locations.has(material)) locations.set(material, station2);
      }
      for (const material of materialIds(move, "SendMatList")) {
        if (!locations.has(material)) locations.set(material, move.ModuleName);
      }
      continue;
    }
    const fallback = PICK_MOVE_TYPES.has(move.MoveType) ? firstStation(move, "SrcStationList") : PLACE_MOVE_TYPES.has(move.MoveType) ? move.ModuleName : move.MoveType === PROCESS_MOVE ? move.ModuleName : "";
    for (const material of materialIds(move)) {
      if (!locations.has(material) && fallback) locations.set(material, fallback);
    }
  }
  return locations;
}
function initialMaterialOrigins(moves) {
  const origins = /* @__PURE__ */ new Map();
  const setOrigin = (material, module, slot = 0) => {
    if (!material || !module || origins.has(material)) return;
    origins.set(material, slot > 0 ? `${module}.${slot}` : module);
  };
  for (const move of moves) {
    if (move.MoveType === SWAP_MOVE2) {
      materialIds(move, "RecvMatList").forEach((material, index) => {
        setOrigin(
          material,
          indexedStation(move, "StationList", index),
          indexedSlot(move, "StnSendSlotList", index)
        );
      });
      for (const material of materialIds(move, "SendMatList")) {
        setOrigin(material, move.ModuleName);
      }
      continue;
    }
    const source = PICK_MOVE_TYPES.has(move.MoveType) ? "SrcStationList" : "";
    const fallback = source ? "" : PLACE_MOVE_TYPES.has(move.MoveType) || move.MoveType === PROCESS_MOVE ? move.ModuleName : "";
    materialIds(move).forEach((material, index) => {
      setOrigin(
        material,
        source ? indexedStation(move, source, index) : fallback,
        source ? indexedSlot(move, "SrcSlotList", index) : 0
      );
    });
  }
  return origins;
}
function applyCompletedTransfer(move, locations) {
  if (PICK_MOVE_TYPES.has(move.MoveType)) {
    for (const material of materialIds(move)) locations.set(material, move.ModuleName);
    return;
  }
  if (PLACE_MOVE_TYPES.has(move.MoveType)) {
    const destination = firstStation(move, "DestStationList");
    if (destination) {
      for (const material of materialIds(move)) locations.set(material, destination);
    }
    return;
  }
  if (move.MoveType === SWAP_MOVE2) {
    const station2 = String(listValue(move.StationList)[0] ?? "");
    for (const material of materialIds(move, "RecvMatList")) locations.set(material, move.ModuleName);
    for (const material of materialIds(move, "SendMatList")) locations.set(material, station2);
  }
}
function indexedStation(move, field, index) {
  const stations = listValue(move[field]).map(String);
  return String(stations[index] ?? stations[0] ?? "");
}
function indexedSlot(move, field, index) {
  const slots = listValue(move[field]);
  const slot = finiteNumber(slots[index] ?? slots[0], 0);
  return Number.isInteger(slot) && slot > 0 ? slot : 0;
}
function loadPortCapacity(device, name, observedMaximum) {
  const definition = device?.Stations?.[name] ?? {};
  const declaredSlots = listValue(definition.Slots).map((value) => finiteNumber(value, 0));
  const declaredCapacity = Math.max(
    finiteNumber(definition.Capacity, 0),
    declaredSlots.length,
    ...declaredSlots
  );
  return Math.max(
    1,
    declaredCapacity || DEFAULT_LOAD_PORT_CAPACITY,
    observedMaximum
  );
}
function stationSlotCapacity(device, name, defaultCapacity = 1) {
  const definition = device?.Stations?.[name] ?? {};
  const declaredSlots = listValue(definition.Slots).map((value) => finiteNumber(value, 0));
  return Math.max(
    1,
    defaultCapacity,
    finiteNumber(definition.Capacity, 0),
    declaredSlots.length,
    ...declaredSlots
  );
}
function buildLoadPortSlots(records, device, time, initialLocations, processedMaterials, replenishments) {
  const names = /* @__PURE__ */ new Set();
  for (const [name, definition] of Object.entries(device?.Stations ?? {})) {
    if (isLoadPortName(name, String(definition?.Type ?? ""))) names.add(name);
  }
  for (const location of initialLocations.values()) {
    if (isLoadPortName(location, String(device?.Stations?.[location]?.Type ?? ""))) names.add(location);
  }
  const observedMaximum = /* @__PURE__ */ new Map();
  for (const move of records) {
    if (!PICK_MOVE_TYPES.has(move.MoveType)) continue;
    materialIds(move).forEach((material, index) => {
      const source = indexedStation(move, "SrcStationList", index);
      const type = String(device?.Stations?.[source]?.Type ?? "");
      if (!source || !isLoadPortName(source, type)) return;
      names.add(source);
      const slot = indexedSlot(move, "SrcSlotList", index);
      if (!slot) return;
      observedMaximum.set(source, Math.max(observedMaximum.get(source) ?? 0, slot));
    });
  }
  const result = /* @__PURE__ */ new Map();
  for (const name of names) {
    const slotMaterialHistory = /* @__PURE__ */ new Map();
    const generationSlots = /* @__PURE__ */ new Map();
    const generationStartTimes = /* @__PURE__ */ new Map([[0, 0]]);
    const materialGenerations = /* @__PURE__ */ new Map();
    for (const move of records) {
      if (!PICK_MOVE_TYPES.has(move.MoveType)) continue;
      materialIds(move).forEach((material, index) => {
        if (indexedStation(move, "SrcStationList", index) !== name) return;
        const slot = indexedSlot(move, "SrcSlotList", index);
        if (!slot) return;
        const instanceId = materialInstanceId(move, material, index);
        const history = slotMaterialHistory.get(slot) ?? [];
        let generation = history.indexOf(instanceId);
        if (generation < 0) {
          generation = history.length;
          history.push(instanceId);
          slotMaterialHistory.set(slot, history);
        }
        const slots = generationSlots.get(generation) ?? /* @__PURE__ */ new Map();
        if (!slots.has(slot)) slots.set(slot, { wafer: material, instanceId });
        generationSlots.set(generation, slots);
        materialGenerations.set(instanceId, generation);
        if (generation > 0) {
          generationStartTimes.set(
            generation,
            Math.min(generationStartTimes.get(generation) ?? Number.POSITIVE_INFINITY, move.StartTime)
          );
        }
      });
    }
    for (const replenishment of replenishments.filter((item) => item.moduleName === name)) {
      const generations = replenishment.materials.map((material) => materialGenerations.get(`${material.wafer}\0${material.taskId}`) ?? materialGenerations.get(material.wafer) ?? [...materialGenerations.entries()].find(([instanceId]) => instanceId === material.wafer || instanceId.startsWith(`${material.wafer}\0`))?.[1]).filter((generation2) => generation2 !== void 0);
      const generation = generations.length ? Math.max(...generations) : Math.max(...generationSlots.keys(), -1) + 1;
      const replenishedSlots = generationSlots.get(generation) ?? /* @__PURE__ */ new Map();
      for (const material of replenishment.materials) {
        const declaredInstanceId = `${material.wafer}\0${material.taskId}`;
        const instanceId = materialGenerations.has(declaredInstanceId) ? declaredInstanceId : [...materialGenerations.keys()].find((candidate) => candidate === material.wafer || candidate.startsWith(`${material.wafer}\0`)) ?? declaredInstanceId;
        replenishedSlots.set(material.slot, { wafer: material.wafer, instanceId });
        materialGenerations.set(instanceId, generation);
        observedMaximum.set(name, Math.max(observedMaximum.get(name) ?? 0, material.slot));
      }
      generationSlots.set(generation, replenishedSlots);
      generationStartTimes.set(
        generation,
        Math.min(generationStartTimes.get(generation) ?? Number.POSITIVE_INFINITY, replenishment.time)
      );
    }
    const activeGeneration = [...generationSlots.keys()].filter((generation) => generation === 0 || (generationStartTimes.get(generation) ?? Number.POSITIVE_INFINITY) <= time).reduce((latest, generation) => Math.max(latest, generation), 0);
    const occupancy = new Map(generationSlots.get(activeGeneration) ?? []);
    if (!occupancy.size && !generationSlots.size) {
      const legacyInitialMaterials = [...initialLocations.entries()].filter(([, location]) => location === name).map(([material]) => material).sort(naturalCompare);
      legacyInitialMaterials.forEach((material, index) => occupancy.set(index + 1, { wafer: material, instanceId: material }));
    }
    for (const move of records) {
      const materials = materialIds(move);
      if (PICK_MOVE_TYPES.has(move.MoveType)) {
        if (move.EndTime > time) continue;
        materials.forEach((material, index) => {
          if (indexedStation(move, "SrcStationList", index) !== name) return;
          const instanceId = materialInstanceId(move, material, index);
          if ((materialGenerations.get(instanceId) ?? 0) !== activeGeneration) return;
          const slot = indexedSlot(move, "SrcSlotList", index);
          if (slot) occupancy.delete(slot);
          else {
            const current = [...occupancy.entries()].find(([, wafer]) => wafer.instanceId === instanceId);
            if (current) occupancy.delete(current[0]);
          }
        });
      } else if (PLACE_MOVE_TYPES.has(move.MoveType) && move.EndTime <= time) {
        materials.forEach((material, index) => {
          if (indexedStation(move, "DestStationList", index) !== name) return;
          const instanceId = materialInstanceId(move, material, index);
          if ((materialGenerations.get(instanceId) ?? 0) !== activeGeneration) return;
          let slot = indexedSlot(move, "DestSlotList", index);
          if (!slot) {
            slot = 1;
            while (occupancy.has(slot)) slot += 1;
          }
          occupancy.set(slot, { wafer: material, instanceId });
          observedMaximum.set(name, Math.max(observedMaximum.get(name) ?? 0, slot));
        });
      }
    }
    const occupiedMaximum = occupancy.size ? Math.max(...occupancy.keys()) : 0;
    const capacity = loadPortCapacity(
      device,
      name,
      Math.max(observedMaximum.get(name) ?? 0, occupiedMaximum, occupancy.size)
    );
    result.set(name, Array.from({ length: capacity }, (_, index) => {
      const occupied = occupancy.get(index + 1);
      return {
        slot: index + 1,
        wafer: occupied?.wafer ?? "",
        processed: Boolean(occupied && processedMaterials.has(occupied.instanceId))
      };
    }));
  }
  return result;
}
function buildReplayStationSlots(records, device, time, initialLocations, processedMaterials, currentMaterialInstances) {
  const isSlottedStation = (name, type) => isLoadLockName(name, type) || type.toLowerCase() === "multiprocesschamber";
  const names = /* @__PURE__ */ new Set();
  for (const [name, definition] of Object.entries(device?.Stations ?? {})) {
    if (isSlottedStation(name, String(definition?.Type ?? ""))) names.add(name);
  }
  for (const location of initialLocations.values()) {
    if (isSlottedStation(location, String(device?.Stations?.[location]?.Type ?? ""))) names.add(location);
  }
  const initialByStation = /* @__PURE__ */ new Map();
  const observedMaximum = /* @__PURE__ */ new Map();
  const occupyInitial = (station2, slot, material) => {
    if (!station2 || !slot || !material || initialLocations.get(material) !== station2) return;
    names.add(station2);
    const occupancy = initialByStation.get(station2) ?? /* @__PURE__ */ new Map();
    if (!occupancy.has(slot)) occupancy.set(slot, material);
    initialByStation.set(station2, occupancy);
    observedMaximum.set(station2, Math.max(observedMaximum.get(station2) ?? 0, slot));
  };
  for (const move of records) {
    if (PICK_MOVE_TYPES.has(move.MoveType)) {
      materialIds(move).forEach((material, index) => {
        const source = indexedStation(move, "SrcStationList", index);
        if (!isSlottedStation(source, String(device?.Stations?.[source]?.Type ?? ""))) return;
        occupyInitial(source, indexedSlot(move, "SrcSlotList", index), material);
      });
    } else if (move.MoveType === SWAP_MOVE2) {
      materialIds(move, "RecvMatList").forEach((material, index) => {
        const station2 = indexedStation(move, "StationList", index);
        if (!isSlottedStation(station2, String(device?.Stations?.[station2]?.Type ?? ""))) return;
        occupyInitial(station2, indexedSlot(move, "StnSendSlotList", index), material);
      });
    }
  }
  const result = /* @__PURE__ */ new Map();
  for (const name of names) {
    const occupancy = new Map(initialByStation.get(name) ?? []);
    const initialMaterials = [...initialLocations.entries()].filter(([, location]) => location === name).map(([material]) => material).sort(naturalCompare);
    const assigned = new Set(occupancy.values());
    let fallbackSlot = 1;
    for (const material of initialMaterials) {
      if (assigned.has(material)) continue;
      while (occupancy.has(fallbackSlot)) fallbackSlot += 1;
      occupancy.set(fallbackSlot, material);
      assigned.add(material);
    }
    for (const move of records) {
      if (move.EndTime > time) continue;
      const materials = materialIds(move);
      if (PICK_MOVE_TYPES.has(move.MoveType)) {
        materials.forEach((material, index) => {
          if (indexedStation(move, "SrcStationList", index) !== name) return;
          const slot = indexedSlot(move, "SrcSlotList", index);
          if (slot) occupancy.delete(slot);
          else {
            const current = [...occupancy.entries()].find(([, wafer]) => wafer === material);
            if (current) occupancy.delete(current[0]);
          }
        });
      } else if (PLACE_MOVE_TYPES.has(move.MoveType)) {
        materials.forEach((material, index) => {
          if (indexedStation(move, "DestStationList", index) !== name) return;
          let slot = indexedSlot(move, "DestSlotList", index);
          if (!slot) {
            slot = 1;
            while (occupancy.has(slot)) slot += 1;
          }
          occupancy.set(slot, material);
          observedMaximum.set(name, Math.max(observedMaximum.get(name) ?? 0, slot));
        });
      } else if (move.MoveType === SWAP_MOVE2) {
        materialIds(move, "RecvMatList").forEach((material, index) => {
          if (indexedStation(move, "StationList", index) !== name) return;
          const slot = indexedSlot(move, "StnSendSlotList", index);
          if (slot) occupancy.delete(slot);
          else {
            const current = [...occupancy.entries()].find(([, wafer]) => wafer === material);
            if (current) occupancy.delete(current[0]);
          }
        });
        materialIds(move, "SendMatList").forEach((material, index) => {
          if (indexedStation(move, "StationList", index) !== name) return;
          let slot = indexedSlot(move, "StnRecvSlotList", index);
          if (!slot) {
            slot = 1;
            while (occupancy.has(slot)) slot += 1;
          }
          occupancy.set(slot, material);
          observedMaximum.set(name, Math.max(observedMaximum.get(name) ?? 0, slot));
        });
      }
    }
    const occupiedMaximum = occupancy.size ? Math.max(...occupancy.keys()) : 0;
    const capacity = loadPortCapacity(
      device,
      name,
      Math.max(observedMaximum.get(name) ?? 0, occupiedMaximum, initialMaterials.length)
    );
    result.set(name, Array.from({ length: capacity }, (_, index) => {
      const wafer = occupancy.get(index + 1) ?? "";
      const instanceId = currentMaterialInstances.get(wafer) ?? wafer;
      return { slot: index + 1, wafer, processed: Boolean(wafer && processedMaterials.has(instanceId)) };
    }));
  }
  return result;
}
function moveProgress(move, time) {
  const duration = move.EndTime - move.StartTime;
  if (duration <= 0) return time >= move.EndTime ? 1 : 0;
  return Math.max(0, Math.min(1, (time - move.StartTime) / duration));
}
function activeTarget(move) {
  return firstStation(move, "DestStationList") || firstStation(move, "SrcStationList") || String(listValue(move.StationList)[0] ?? "") || (!isRobotName(move.ModuleName) ? move.ModuleName : "");
}
function buildWorkspaceSnapshot(moves, device, requestedTime, replenishments = []) {
  const records = normalizeMoves(moves);
  const endTime = records.reduce((maximum, move) => Math.max(maximum, move.EndTime), 0);
  const normalizedRequestedTime = requestedTime === Number.POSITIVE_INFINITY ? endTime : finiteNumber(requestedTime);
  const time = Math.max(0, Math.min(normalizedRequestedTime, endTime));
  const robotNames = collectRobotNames(records, device);
  const robotNameSet = new Set(robotNames);
  const definitions = collectModuleDefinitions(records, device, robotNameSet);
  const initialLocations = initialMaterialLocations(records);
  const waferOrigins = initialMaterialOrigins(records);
  const locations = new Map(initialLocations);
  const doorStates = /* @__PURE__ */ new Map();
  const loadLockDoors = projectLoadLockDoors(records, device, time, [...definitions].filter(([name, definition]) => isLoadLockName(name, definition.type)).map(([name]) => name));
  const environments = /* @__PURE__ */ new Map();
  const requiredProcesses = /* @__PURE__ */ new Map();
  for (const move of records) {
    if (move.MoveType !== PROCESS_MOVE) continue;
    materialIds(move).forEach((material, index) => {
      const instanceId = materialInstanceId(move, material, index);
      requiredProcesses.set(instanceId, (requiredProcesses.get(instanceId) ?? 0) + 1);
    });
  }
  const completedProcesses = /* @__PURE__ */ new Map();
  const processedMaterials = /* @__PURE__ */ new Set();
  const currentMaterialInstances = /* @__PURE__ */ new Map();
  for (const move of records) {
    materialIds(move).forEach((material, index) => {
      if (!currentMaterialInstances.has(material)) {
        currentMaterialInstances.set(material, materialInstanceId(move, material, index));
      }
    });
  }
  const activeMoves = [];
  let completedMoves = 0;
  for (const [name, definition] of definitions) {
    doorStates.set(name, isDoorlessModule(name, definition.type) ? "doorless" : "closed");
    if (isLoadLockName(name, definition.type)) {
      environments.set(name, initialLoadLockEnvironment(device, name));
    }
  }
  for (const move of records) {
    const active = move.StartTime <= time && time < move.EndTime;
    const completed = move.EndTime <= time;
    if (move.StartTime <= time) {
      materialIds(move).forEach((material, index) => {
        currentMaterialInstances.set(material, materialInstanceId(move, material, index));
      });
    }
    if (active) activeMoves.push(move);
    if (completed) {
      completedMoves += 1;
      applyCompletedTransfer(move, locations);
      if (move.MoveType === PROCESS_MOVE) {
        materialIds(move).forEach((material, index) => {
          const instanceId = materialInstanceId(move, material, index);
          const completed2 = (completedProcesses.get(instanceId) ?? 0) + 1;
          completedProcesses.set(instanceId, completed2);
          if (completed2 >= (requiredProcesses.get(instanceId) ?? 1)) {
            processedMaterials.add(instanceId);
          }
        });
      }
    }
    const doorVisualActive = move.StartTime <= time && time < move.EndTime;
    if (move.MoveType === PREPARE_MOVE) {
      if (doorVisualActive) doorStates.set(move.ModuleName, "opening");
      else if (completed) doorStates.set(move.ModuleName, "open");
    } else if (move.MoveType === COMPLETE_MOVE) {
      if (doorVisualActive) doorStates.set(move.ModuleName, "closing");
      else if (completed) doorStates.set(move.ModuleName, "closed");
    } else if (LOADLOCK_ENVIRONMENT_MOVE_TYPES.has(move.MoveType) && (active || completed)) {
      const currentState = move.MoveType === PUMP_MOVE ? "VAC" : move.MoveType === VENT_MOVE ? "ATM" : String(move.CurState ?? "");
      const environment = /VTR|VAC/i.test(currentState) ? "\u771F\u7A7A" : /ATR|ATM/i.test(currentState) ? "\u5927\u6C14" : currentState;
      if (environment) environments.set(move.ModuleName, active ? `${environment}\u5207\u6362\u4E2D` : environment);
    }
  }
  for (const replenishment of replenishments) {
    if (replenishment.time > time) continue;
    for (const material of replenishment.materials) {
      currentMaterialInstances.set(material.wafer, `${material.wafer}\0${material.taskId}`);
    }
  }
  const isProcessed = (material) => processedMaterials.has(
    currentMaterialInstances.get(material) ?? material
  );
  const robotTargets = /* @__PURE__ */ new Map();
  for (const move of activeMoves) {
    if (isRobotName(move.ModuleName, robotNameSet)) robotTargets.set(move.ModuleName, activeTarget(move));
  }
  const lastRobotTargets = /* @__PURE__ */ new Map();
  for (const move of records) {
    if (move.StartTime > time || !isRobotName(move.ModuleName, robotNameSet)) continue;
    const target = activeTarget(move);
    if (target) lastRobotTargets.set(move.ModuleName, target);
  }
  const wafersByLocation = /* @__PURE__ */ new Map();
  for (const [material, location] of locations) {
    if (!location) continue;
    const wafers = wafersByLocation.get(location) ?? [];
    wafers.push(material);
    wafersByLocation.set(location, wafers);
  }
  for (const wafers of wafersByLocation.values()) wafers.sort(naturalCompare);
  const loadPortSlots = buildLoadPortSlots(
    records,
    device,
    time,
    initialLocations,
    processedMaterials,
    replenishments
  );
  const stationSlotSnapshots = buildReplayStationSlots(
    records,
    device,
    time,
    initialLocations,
    processedMaterials,
    currentMaterialInstances
  );
  const modules = [...definitions.entries()].map(([name, definition]) => {
    const moduleMoves = activeMoves.filter((move) => move.ModuleName === name || firstStation(move, "SrcStationList") === name || firstStation(move, "DestStationList") === name || listValue(move.StationList).map(String).includes(name));
    const primaryMove = moduleMoves.find(isCleaningMove) ?? moduleMoves.find((move) => move.MoveType === PROCESS_MOVE) ?? moduleMoves.find((move) => LOADLOCK_ENVIRONMENT_MOVE_TYPES.has(move.MoveType)) ?? moduleMoves.find((move) => [PREPARE_MOVE, COMPLETE_MOVE].includes(move.MoveType)) ?? moduleMoves[0];
    let status = (wafersByLocation.get(name)?.length ?? 0) > 0 ? "occupied" : "idle";
    if (primaryMove && isCleaningMove(primaryMove)) status = "cleaning";
    else if (primaryMove?.MoveType === PROCESS_MOVE) status = "processing";
    else if (primaryMove && LOADLOCK_ENVIRONMENT_MOVE_TYPES.has(primaryMove.MoveType)) status = "environment";
    else if (primaryMove && [PREPARE_MOVE, COMPLETE_MOVE].includes(primaryMove.MoveType)) status = "door";
    else if (primaryMove) status = "transfer";
    const currentEnvironment = String(primaryMove?.CurState ?? "");
    const prePrepareType = String(primaryMove?.PrePrepareType ?? "");
    const loadLockPhase = primaryMove && LOADLOCK_ENVIRONMENT_MOVE_TYPES.has(primaryMove.MoveType) ? primaryMove.MoveType === PUMP_MOVE || /VTR|VAC|PUMP/i.test(`${currentEnvironment} ${prePrepareType}`) ? "pumping" : primaryMove.MoveType === VENT_MOVE || /ATR|ATM|VENT/i.test(`${currentEnvironment} ${prePrepareType}`) ? "venting" : "" : "";
    return {
      name,
      type: definition.type,
      status,
      door: doorStates.get(name) ?? "closed",
      loadLockDoors: loadLockDoors.get(name),
      wafers: wafersByLocation.get(name) ?? [],
      processedWafers: (wafersByLocation.get(name) ?? []).filter(isProcessed),
      loadPortSlots: loadPortSlots.get(name) ?? [],
      loadLockSlots: isLoadLockName(name, definition.type) ? stationSlotSnapshots.get(name) ?? [] : [],
      processSlots: definition.type.toLowerCase() === "multiprocesschamber" ? stationSlotSnapshots.get(name) : void 0,
      slotCapacity: stationSlotCapacity(device, name, isCoolerModule(name, definition.type) ? 3 : 1),
      activeMoveName: primaryMove ? isCleaningMove(primaryMove) ? "\u6E05\u6D01" : MOVE_NAMES[primaryMove.MoveType] ?? `\u52A8\u4F5C ${primaryMove.MoveType}` : "",
      progress: primaryMove ? moveProgress(primaryMove, time) : 0,
      environment: environments.get(name) ?? "",
      loadLockPhase,
      isRobotTarget: [...robotTargets.values()].includes(name)
    };
  }).sort((left, right) => naturalCompare(left.name, right.name));
  const robots = robotNames.map((name) => {
    const move = activeMoves.find((record) => record.ModuleName === name);
    const definition = device?.Robots?.[name] ?? {};
    const wafers = wafersByLocation.get(name) ?? [];
    return {
      name,
      type: String(definition.Type ?? ""),
      capacity: robotCapacity(definition, wafers.length),
      arms: configuredRobotArms(definition),
      slotWafers: robotSlotWafers(records, time, name, wafers),
      environment: robotEnvironment(name, definition),
      railMotion: robotEnvironment(name, definition) === "atmosphere" ? atmosphereRailMotion(records, name, time) : void 0,
      wafers,
      processedWafers: wafers.filter(isProcessed),
      busy: Boolean(move),
      source: move ? firstStation(move, "SrcStationList") : "",
      target: robotTargets.get(name) ?? lastRobotTargets.get(name) ?? "",
      activeMoveName: move ? MOVE_NAMES[move.MoveType] ?? `\u52A8\u4F5C ${move.MoveType}` : "",
      isPreTrans: move?.MoveType === PRE_TRANS_MOVE2,
      preTransProgress: move?.MoveType === PRE_TRANS_MOVE2 ? moveProgress(move, time) : 1
    };
  });
  return {
    time,
    endTime,
    completedMoves,
    totalMoves: records.length,
    activeMoves,
    modules,
    robots,
    waferOrigins: Object.fromEntries(waferOrigins),
    waferCount: new Set(records.flatMap((move) => materialIds(move))).size
  };
}
function stationCapacity(device, name) {
  const definition = device?.Stations?.[name] ?? {};
  const slots = listValue(definition.Slots).map((value) => finiteNumber(value, 0)).filter((value) => Number.isInteger(value) && value > 0);
  return Math.max(1, finiteNumber(definition.Capacity, 0), slots.length);
}
function routeByPJobName(plan, pjobName) {
  const routes = Array.isArray(plan?.routes) ? plan.routes : [];
  const routeByName = new Map(routes.filter((route) => route && typeof route === "object" && !Array.isArray(route)).map((route) => [String(route.name ?? ""), route]));
  const aliases = /* @__PURE__ */ new Map();
  const rounds = Array.isArray(plan?.rounds) ? plan.rounds : [];
  rounds.forEach((round, roundIndex) => {
    const cjobs = Array.isArray(round?.cjobs) ? round.cjobs : [];
    cjobs.forEach((cjob, cjobIndex) => {
      const row = cjob;
      const cjobName = String(row.key ?? `C${cjobIndex + 1}`);
      const pjobs = Array.isArray(row.pjobs) ? row.pjobs : [];
      pjobs.forEach((pjob, pjobIndex) => {
        const job = pjob;
        const shortName = String(job.jobName ?? `P${pjobIndex + 1}`);
        const route = routeByName.get(String(job.routeRef ?? ""));
        if (!route) return;
        aliases.set(`${roundIndex + 1}.${cjobName}.${shortName}`, route);
        if (!aliases.has(shortName)) aliases.set(shortName, route);
      });
    });
  });
  return aliases.get(pjobName) ?? aliases.get(pjobName.split(".").at(-1) ?? "") ?? null;
}
function replayMaterialProgress(records) {
  const progress = /* @__PURE__ */ new Map();
  const update = (move, materials, stepField, pjobOffset = 0) => {
    const stepIds = listValue(move[stepField]);
    const pjobs = listValue(move.PJobName);
    materials.forEach((material, index) => {
      const previous = progress.get(material) ?? { pjobName: "", stepId: "", explicitTargets: [] };
      const explicitTarget = indexedStation(move, "DestStationList", index);
      progress.set(material, {
        pjobName: String(pjobs[pjobOffset + index] ?? pjobs[index] ?? previous.pjobName),
        stepId: String(stepIds[index] ?? previous.stepId),
        explicitTargets: explicitTarget ? [explicitTarget] : []
      });
    });
  };
  for (const move of [...records].sort((left, right) => left.EndTime - right.EndTime || left.MoveID - right.MoveID)) {
    if (move.MoveType === SWAP_MOVE2) {
      const received = materialIds(move, "RecvMatList");
      update(move, received, "RecvMatStepIDList");
      update(move, materialIds(move, "SendMatList"), "SendMatStepIDList", received.length);
    } else {
      update(move, materialIds(move), "StepIDList");
    }
  }
  return progress;
}
function nextRouteResources(plan, progress) {
  if (!progress) return [];
  if (progress.explicitTargets.length) return progress.explicitTargets;
  const route = routeByPJobName(plan, progress.pjobName);
  const stages = Array.isArray(route?.stages) ? route.stages : [];
  const currentIndex = stages.findIndex((stage) => String(stage.stepId ?? "") === progress.stepId);
  if (currentIndex < 0) return [];
  const postStepIds = listValue(stages[currentIndex].postStepIds).map(String);
  const nextStages = postStepIds.length ? stages.filter((stage) => postStepIds.includes(String(stage.stepId ?? ""))) : stages.slice(currentIndex + 1, currentIndex + 2);
  return [...new Set(nextStages.flatMap((stage) => Array.isArray(stage.visits) ? stage.visits.map((visit) => String(visit.stationName ?? "")) : []).filter(Boolean))];
}
function hasConsistentTransferReplay(records, device) {
  const locations = initialMaterialLocations(records);
  const robotNames = new Set(Object.keys(device.Robots ?? {}));
  const locationCount = (location) => [...locations.values()].filter((current) => current === location).length;
  const orderedTransfers = records.filter((move) => PICK_MOVE_TYPES.has(move.MoveType) || PLACE_MOVE_TYPES.has(move.MoveType) || move.MoveType === SWAP_MOVE2).sort((left, right) => left.EndTime - right.EndTime || left.MoveID - right.MoveID);
  for (const move of orderedTransfers) {
    if (PICK_MOVE_TYPES.has(move.MoveType)) {
      const materials = materialIds(move);
      for (let index = 0; index < materials.length; index += 1) {
        const material = materials[index];
        const source = indexedStation(move, "SrcStationList", index);
        if (!source || locations.get(material) !== source) return false;
        const robotDefinition = device.Robots?.[move.ModuleName] ?? {};
        if (!robotNames.has(move.ModuleName) || locationCount(move.ModuleName) >= robotCapacity(robotDefinition)) return false;
        locations.set(material, move.ModuleName);
      }
      continue;
    }
    if (PLACE_MOVE_TYPES.has(move.MoveType)) {
      const materials = materialIds(move);
      for (let index = 0; index < materials.length; index += 1) {
        const material = materials[index];
        const destination = indexedStation(move, "DestStationList", index);
        if (!destination || locations.get(material) !== move.ModuleName) return false;
        if (locationCount(destination) >= stationCapacity(device, destination)) return false;
        locations.set(material, destination);
      }
      continue;
    }
    const received = materialIds(move, "RecvMatList");
    const sent = materialIds(move, "SendMatList");
    for (let index = 0; index < received.length; index += 1) {
      const station2 = indexedStation(move, "StationList", index);
      if (!station2 || locations.get(received[index]) !== station2) return false;
      locations.set(received[index], move.ModuleName);
    }
    for (let index = 0; index < sent.length; index += 1) {
      const station2 = indexedStation(move, "StationList", index);
      if (!station2 || locations.get(sent[index]) !== move.ModuleName) return false;
      if (locationCount(station2) >= stationCapacity(device, station2)) return false;
      locations.set(sent[index], station2);
    }
  }
  return true;
}
function detectTerminalPlaybackDeadlock(moves, device, plan) {
  if (!moves.length || !device || !plan) return null;
  const records = normalizeMoves(moves);
  if (!hasConsistentTransferReplay(records, device)) return null;
  const snapshot = buildWorkspaceSnapshot(records, device, Number.POSITIVE_INFINITY);
  const progress = replayMaterialProgress(records);
  const modules = new Map(snapshot.modules.map((module) => [module.name, module]));
  const robotNames = new Set(snapshot.robots.map((robot) => robot.name));
  const blockingTargets = (robot, wafer) => {
    const targets = nextRouteResources(plan, progress.get(wafer)).filter((target) => !robotNames.has(target));
    if (!targets.length) return [];
    const blocked = targets.filter((target) => {
      const chamber = modules.get(target);
      if (!chamber || chamber.wafers.length < stationCapacity(device, target)) return false;
      return chamber.wafers.some((occupant) => nextRouteResources(plan, progress.get(occupant)).includes(robot.name));
    });
    return blocked.length === targets.length ? blocked : [];
  };
  for (const robot of snapshot.robots) {
    const held = [...robot.wafers].sort(naturalCompare);
    if (robot.capacity === 1 && held.length === 1) {
      const targets = blockingTargets(robot, held[0]);
      if (!targets.length) continue;
      const occupants = [...new Set(targets.flatMap((target) => modules.get(target)?.wafers ?? []))].sort(naturalCompare);
      return {
        Code: "DEADLOCK.SINGLE_ARM_TARGET_FULL",
        Category: "single-arm-target-full",
        Message: `${robot.name} \u7684\u552F\u4E00\u624B\u81C2\u6301\u6709\u6676\u5706 ${held[0]}\uFF0C\u76EE\u6807 ${targets.join("\u3001")} \u88AB\u6676\u5706 ${occupants.join("\u3001")} \u5360\u7528\uFF1B\u5B83\u6CA1\u6709\u7A7A\u624B\u63A5\u8D70\u8154\u5185\u6676\u5706\uFF0C\u6301\u7247\u53C8\u5FC5\u987B\u7B49\u76EE\u6807\u817E\u7A7A\u624D\u80FD\u653E\u4E0B\uFF0C\u5F62\u6210\u76F8\u4E92\u7B49\u5F85\u3002`
      };
    }
    if (robot.capacity === 2 && held.length === 2) {
      const targetsByWafer = held.map((wafer) => blockingTargets(robot, wafer));
      if (targetsByWafer.some((targets2) => !targets2.length)) continue;
      const targets = [...new Set(targetsByWafer.flat())].sort(naturalCompare);
      return {
        Code: "DEADLOCK.DUAL_ARM_TARGETS_FULL",
        Category: "dual-arm-targets-full",
        Message: `${robot.name} \u4E24\u53EA\u624B\u81C2\u6301\u6709\u6676\u5706 ${held.join("\u3001")}\uFF0C\u76EE\u6807 ${targets.join("\u3001")} \u5747\u5DF2\u6EE1\uFF1B\u6CA1\u6709\u7A7A\u624B\u63A5\u8D70\u8154\u5185\u6676\u5706 ${[...new Set(targets.flatMap((target) => modules.get(target)?.wafers ?? []))].sort(naturalCompare).join("\u3001")}\uFF0C\u6301\u7247\u53C8\u5FC5\u987B\u7B49\u76EE\u6807\u817E\u7A7A\u624D\u80FD\u653E\u4E0B\uFF0C\u5F62\u6210\u76F8\u4E92\u7B49\u5F85\u3002`
      };
    }
  }
  return null;
}
function collectElements(root) {
  const required = (id) => {
    const element = root.getElementById(id);
    if (!element) throw new Error(`\u7ED3\u679C\u5206\u6790\u9875\u9762\u7F3A\u5C11\u9875\u9762\u8282\u70B9\uFF1A${id}`);
    return element;
  };
  const optionalSelect = (id, value) => root.getElementById(id) ?? { value, addEventListener: () => void 0 };
  return {
    toolbar: required("visualToolbar"),
    groupAnalysis: required("testGroupAnalysisPanel"),
    empty: required("visualEmpty"),
    playbackEmpty: required("visualPlaybackEmpty"),
    content: required("visualContent"),
    topologyPlayback: required("visualTopologyPlayback"),
    stage: required("visualDeviceStage"),
    /* 独立逻辑测试可使用精简页面夹具；真实页面始终提供该节点。 */
    frontSlotOverview: root.getElementById("visualFrontSlotOverview") ?? { innerHTML: "", style: { setProperty() {
    } } },
    decisionLens: required("visualDecisionLens"),
    actionStatusFilters: Array.from(root.querySelectorAll("[data-action-status-filter]")),
    activeMoves: required("visualActiveMoves"),
    source: required("visualSource"),
    currentTime: required("visualCurrentTime"),
    totalTime: required("visualTotalTime"),
    progressText: required("visualProgressText"),
    moveText: required("visualMoveText"),
    waferText: required("visualWaferText"),
    range: required("visualTimeline"),
    playButton: required("visualPlayButton"),
    speed: required("visualSpeed"),
    fileInput: required("visualFileInput"),
    importButton: root.getElementById("visualImportButton"),
    exportDiagnosticButton: root.getElementById("visualExportDeadlockDiagnostic"),
    openGantt: required("visualOpenGantt"),
    resultButton: required("workspaceResultButton"),
    performance: required("visualPerformance"),
    performanceWindow: required("performanceWindow")
  };
}
function icon(name) {
  const paths = {
    play: '<path d="M8 5v14l11-7z"/>',
    pause: '<path d="M7 5h4v14H7zM15 5h4v14h-4z"/>',
    robot: '<rect x="5" y="7" width="14" height="11" rx="3"/><path d="M12 3v4M8 12h.01M16 12h.01M9 18v3M15 18v3"/>',
    upload: '<path d="M12 16V4m0 0L7 9m5-5 5 5M5 15v5h14v-5"/>'
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
}
function candidateDestinations(decision) {
  const destinations = /* @__PURE__ */ new Map();
  for (const candidate of decision?.candidates ?? []) {
    if (!candidate.destination) continue;
    const previous = destinations.get(candidate.destination);
    destinations.set(candidate.destination, {
      count: (previous?.count ?? 0) + 1,
      bestRank: Math.min(previous?.bestRank ?? Number.POSITIVE_INFINITY, candidate.rank),
      preference: Math.max(previous?.preference ?? 0, candidate.policyPreference),
      makespanDelta: candidate.makespanDelta === null ? previous?.makespanDelta ?? null : Math.min(previous?.makespanDelta ?? Number.POSITIVE_INFINITY, candidate.makespanDelta),
      selected: Boolean(previous?.selected || candidate.selected)
    });
  }
  return destinations;
}
function snapshotWithCandidateModules(snapshot, decision, device) {
  const modules = [...snapshot.modules];
  const knownNames = new Set(modules.map((module) => module.name));
  const configuredRobotNames = new Set(Object.keys(device?.Robots ?? {}));
  const stationDefinitions = device?.Stations ?? {};
  const hasConfiguredStations = Object.keys(stationDefinitions).length > 0;
  for (const candidate of decision?.candidates ?? []) {
    const name = candidate.destination;
    if (!name || isRobotName(name, configuredRobotNames) || knownNames.has(name)) continue;
    if (hasConfiguredStations && !stationDefinitions[name]) continue;
    const type = String(stationDefinitions[name]?.Type ?? "");
    modules.push({
      name,
      type,
      status: "idle",
      door: "closed",
      wafers: [],
      processedWafers: [],
      loadPortSlots: [],
      loadLockSlots: [],
      slotCapacity: stationSlotCapacity(device, name, isCoolerModule(name, type) ? 3 : 1),
      activeMoveName: "",
      progress: 0,
      environment: isLoadLockName(name, type) ? initialLoadLockEnvironment(device, name) : "",
      loadLockPhase: "",
      isRobotTarget: false
    });
    knownNames.add(name);
  }
  return {
    ...snapshot,
    modules: modules.sort((left, right) => naturalCompare(left.name, right.name))
  };
}
function snapshotWithFullDeviceModules(snapshot, device) {
  const modules = [...snapshot.modules];
  const knownNames = new Set(modules.map((module) => module.name));
  const configuredRobotNames = new Set(Object.keys(device?.Robots ?? {}));
  for (const [name, definition] of Object.entries(device?.Stations ?? {})) {
    if (knownNames.has(name) || isRobotName(name, configuredRobotNames)) continue;
    const type = String(definition?.Type ?? "");
    const slotCapacity = stationSlotCapacity(device, name, isCoolerModule(name, type) ? 3 : 1);
    modules.push({
      name,
      type,
      status: "idle",
      door: isDoorlessModule(name, type) ? "doorless" : "closed",
      wafers: [],
      processedWafers: [],
      loadPortSlots: isLoadPortName(name, type) ? Array.from({ length: loadPortCapacity(device, name, 0) }, (_, index) => ({
        slot: index + 1,
        wafer: "",
        processed: false
      })) : [],
      loadLockSlots: [],
      slotCapacity,
      activeMoveName: "",
      progress: 0,
      environment: isLoadLockName(name, type) ? initialLoadLockEnvironment(device, name) : "",
      loadLockPhase: "",
      isRobotTarget: false
    });
    knownNames.add(name);
  }
  return {
    ...snapshot,
    modules: modules.sort((left, right) => naturalCompare(left.name, right.name))
  };
}
function topologyGroups(modules) {
  const loadLocks = modules.filter((module) => isLoadLockName(module.name, module.type));
  const loadPorts = modules.filter((module) => isLoadPortName(module.name, module.type));
  const processModules = modules.filter((module) => isProcessModule(module.name, module.type) || isHeaterModule(module.name, module.type));
  const assignedNames = new Set([...loadLocks, ...loadPorts, ...processModules].map((module) => module.name));
  return {
    processModules,
    loadLocks,
    loadPorts,
    auxiliaryModules: modules.filter((module) => !assignedNames.has(module.name))
  };
}
function expandDualProcessChambers(modules) {
  const expanded = [];
  for (const module of modules) {
    if (module.slotCapacity < 2) {
      expanded.push({ view: module, sourceName: module.name });
      continue;
    }
    for (let index = 0; index < module.slotCapacity; index += 1) {
      const wafer = module.processSlots ? module.processSlots.find((slot) => slot.slot === index + 1)?.wafer ?? "" : module.wafers[index] ?? "";
      expanded.push({
        view: {
          ...module,
          name: `${module.name}-${index + 1}`,
          wafers: wafer ? [wafer] : [],
          processedWafers: wafer && module.processedWafers.includes(wafer) ? [wafer] : [],
          slotCapacity: 1
        },
        sourceName: module.name
      });
    }
  }
  return expanded;
}
function renderWaferToken(wafer, origin, progress, processed = false) {
  const normalizedProgress = Math.max(0, Math.min(1, progress));
  const state2 = processed ? "processed" : "unprocessed";
  const originLabel = origin || "\u6765\u6E90\u672A\u77E5";
  const surfaceLabel = waferSurfaceLabel(wafer, origin);
  const dummyClass = isDummyWafer(wafer, origin) ? " wafer-dummy" : "";
  return `<span class="wafer-token wafer-${state2}${dummyClass}" style="--wafer-progress:${normalizedProgress * 360}deg" title="\u6676\u5706 ${escapeHtml(wafer)}\uFF0C\u6765\u6E90 ${escapeHtml(originLabel)}\uFF0C${processed ? "\u5DF2\u52A0\u5DE5" : "\u672A\u52A0\u5DE5"}"><span><b class="wafer-origin-label">${escapeHtml(surfaceLabel)}</b></span></span>`;
}
function moduleDoorSides(module, role, layout = "single", roleIndex = 0, attachmentId = "") {
  if (module.door === "doorless") return [];
  if (role === "lock") return ["top", "bottom"];
  if (role === "port") return ["top"];
  const name = module.name.trim().toUpperCase();
  if (role === "process" && attachmentId) {
    if (attachmentId.endsWith("@left")) return ["right"];
    if (attachmentId.endsWith("@right")) return ["left"];
    if (attachmentId.endsWith("@top")) return ["bottom"];
    if (attachmentId.endsWith("@bottom")) return ["top"];
  }
  if (layout === "cascade" && role === "process") {
    const cascadeDoorSides = [
      ["right"],
      ["left"],
      ["bottom"],
      ["right"],
      ["left"],
      ["left"]
    ];
    return cascadeDoorSides[roleIndex] ?? ["top"];
  }
  if (layout === "dual" && role === "process") {
    const dualDoorSides = [
      ["right"],
      ["right"],
      ["bottom"],
      ["bottom"],
      ["left"],
      ["left"]
    ];
    return dualDoorSides[roleIndex] ?? ["top"];
  }
  if (role === "process") {
    const standardDoorSides = [
      ["right"],
      ["left"],
      ["bottom"],
      ["bottom"],
      ["left"],
      ["left"]
    ];
    return standardDoorSides[roleIndex] ?? ["top"];
  }
  if (name === "HEATER") return ["left"];
  if (["AL", "ALIGNER"].includes(name)) return ["right"];
  if (["CL", "COOLER"].includes(name)) return ["left"];
  return ["top"];
}
function visibleModuleSlots(module, kind) {
  const recordedSlots = kind === "port" ? module.loadPortSlots : kind === "lock" ? module.loadLockSlots : [];
  if (recordedSlots.length) return recordedSlots;
  const slotCount = Math.max(kind === "lock" ? 2 : 1, module.slotCapacity, module.wafers.length);
  return Array.from({ length: slotCount }, (_, index) => ({
    slot: index + 1,
    wafer: module.wafers[index] ?? "",
    processed: module.processedWafers.includes(module.wafers[index] ?? "")
  }));
}
function renderFrontSlotOverview(modules, waferOrigins = {}, robots = [], layout = "single", device) {
  const visibleModules = modules.filter((module) => !isTopologyHiddenModule(module));
  const moduleNameOrder = (left, right) => {
    const leftName = left.module.name.trim();
    const rightName = right.module.name.trim();
    const leftPort = /^LP(\d+)$/i.exec(leftName);
    const rightPort = /^LP(\d+)$/i.exec(rightName);
    if (leftPort && rightPort) return Number(leftPort[1]) - Number(rightPort[1]);
    if (leftPort) return -1;
    if (rightPort) return 1;
    return leftName.localeCompare(rightName, void 0, { numeric: true });
  };
  const loadPorts = visibleModules.filter((module) => isLoadPortName(module.name, module.type)).map((module) => ({ module, kind: "port" })).sort(moduleNameOrder);
  const coolers = visibleModules.filter((module) => isCoolerModule(module.name, module.type)).map((module) => ({ module, kind: "cooler" })).sort(moduleNameOrder);
  const loadLocks = visibleModules.filter((module) => isLoadLockName(module.name, module.type)).map((module) => ({ module, kind: "lock" })).sort(moduleNameOrder);
  const bridgeNames = layout === "cascade" ? cascadeBridgeLoadLockNames(
    Object.keys(device?.Stations ?? {}).filter((name) => loadLocks.some((item) => item.module.name === name)),
    device,
    robots.filter((robot) => robot.environment === "vacuum").map((robot) => robot.name)
  ) : /* @__PURE__ */ new Set();
  const lockPosition = (item) => moduleTopologyPosition(
    item.module,
    "lock",
    0,
    loadLocks.map((item2) => item2.module),
    layout,
    bridgeNames
  );
  if (robots.length && layout !== "dual") loadLocks.sort((left, right) => lockPosition(left).topPixels - lockPosition(right).topPixels || lockPosition(left).leftPercent - lockPosition(right).leftPercent);
  const splitRows = (items, columns) => Array.from({ length: Math.ceil(items.length / columns) }, (_, index) => items.slice(index * columns, (index + 1) * columns));
  const slotRows = [
    ...splitRows(loadLocks, 2),
    ...splitRows(loadPorts, 2),
    ...splitRows(coolers, 2)
  ].filter((row) => row.length);
  const renderSlots = (slots, module) => slots.map((slot) => {
    const state2 = !slot.wafer ? "empty" : slot.processed ? "processed" : "unprocessed";
    const dummy = Boolean(slot.wafer) && isDummyWafer(
      slot.wafer,
      waferOrigins[slot.wafer] ?? `${module.name}.${slot.slot}`
    );
    const identity = `${module.name}.${slot.slot}`;
    const detail = slot.wafer ? `${identity} \xB7 \u6676\u5706 ${waferSurfaceLabel(slot.wafer, waferOrigins[slot.wafer] ?? "")}\uFF0C${slot.processed ? "\u5DF2\u52A0\u5DE5" : "\u672A\u52A0\u5DE5"}` : `${identity} \xB7 \u7A7A\u69FD`;
    return `<span class="front-slot is-${state2}${dummy ? " is-dummy" : ""}" tabindex="0" title="${escapeHtml(detail)}" aria-label="${escapeHtml(detail)}"></span>`;
  }).join("");
  if (!slotRows.length && !robots.length) return "";
  const renderModule2 = ({ module, kind }) => {
    const slots = visibleModuleSlots(module, kind);
    return `<div class="front-module">
      <strong title="${escapeHtml(module.name)}">${escapeHtml(module.name)}</strong>
      <div class="front-slot-board" style="--front-slot-count:${slots.length}" role="group" aria-label="${escapeHtml(`${module.name} \u6B63\u89C6\u69FD\u4F4D`)}">${renderSlots(slots, module)}</div>
    </div>`;
  };
  const positionedRows = slotRows.map((row) => {
    const role = row[0].kind === "port" ? "port" : row[0].kind === "lock" ? "lock" : "auxiliary";
    const peers = visibleModules.filter((module) => role === "port" ? isLoadPortName(module.name, module.type) : role === "lock" ? isLoadLockName(module.name, module.type) : isCoolerModule(module.name, module.type));
    return {
      top: moduleTopologyPosition(row[0].module, role, peers.indexOf(row[0].module), peers, layout, bridgeNames).topPixels,
      category: role === "lock" ? 1 : role === "port" ? 2 : 3,
      markup: `<div class="front-slot-row front-slot-row-${row[0].kind}" style="--front-row-module-count:${row.length}">${row.map(renderModule2).join("")}</div>`
    };
  });
  for (const robot of robots) {
    const peers = robots.filter((item) => item.environment === robot.environment);
    positionedRows.push({
      top: robotTopologyPosition(peers.indexOf(robot), peers.length, robot.environment, layout).topPixels,
      category: 0,
      markup: renderRobotSlotRow(robot, layout === "dual", (slots) => renderSlots(slots, robot), escapeHtml)
    });
  }
  const content = positionedRows.sort((a, b) => layout === "dual" ? a.category - b.category || (a.category === 0 ? a.top - b.top : 0) : a.top - b.top).map((row) => row.markup).join("");
  return `<div class="topology-front-content" role="group" aria-label="\u8BBE\u5907\u6B63\u89C6\u69FD\u4F4D">${content}</div>`;
}
function renderLoadPortTopView(module, wafers, accessibleStatus, candidate) {
  const slots = visibleModuleSlots(module, "port");
  const processed = slots.filter((slot) => slot.wafer && slot.processed).length;
  const unprocessed = slots.filter((slot) => slot.wafer && !slot.processed).length;
  const candidateLabel = candidate ? `\uFF0C${candidate.count} \u4E2A\u53EF\u884C\u52A8\u4F5C` : "";
  const isDummy = isDummyPortName(module.name) || module.type.trim().toLowerCase() === "dummyport";
  return `<strong class="equipment-external-name equipment-external-name-port">${escapeHtml(module.name)}</strong>
    <article class="equipment-card equipment-port-top-view status-${module.status} door-${module.door} ${isDummy ? "is-dummy-port" : ""} ${module.isRobotTarget ? "is-target" : ""} ${candidate ? "is-candidate-destination" : ""}" aria-label="${escapeHtml(`${accessibleStatus}\uFF0C\u4FEF\u89C6\u88C5\u8F7D\u53F0\uFF0C\u5171 ${slots.length} \u4E2A\u69FD\u4F4D\uFF0C\u672A\u52A0\u5DE5 ${unprocessed}\uFF0C\u5DF2\u52A0\u5DE5 ${processed}${candidateLabel}`)}">
      <span class="port-top-cassette ${wafers ? "is-occupied" : "is-empty"}">${wafers || "<i></i>"}</span>
    </article>${module.door === "doorless" ? "" : `<div class="external-module-doors door-${module.door}" title="${escapeHtml(DOOR_LABELS[module.door])}"><i class="external-module-door external-module-door-top"></i></div>`}`;
}
function renderModule(module, waferOrigins, role, candidate, layout = "single", roleIndex = 0, attachmentId = "") {
  const waferProgress = module.status === "processing" ? module.progress : 0;
  const visibleWaferCount = role === "lock" ? 2 : 1;
  const processedWafers = new Set(module.processedWafers ?? []);
  const wafers = module.wafers.slice(0, visibleWaferCount).map((wafer) => renderWaferToken(wafer, waferOrigins[wafer] ?? "", waferProgress, processedWafers.has(wafer))).join("");
  const layerCount = role === "lock" && module.loadLockSlots.length ? module.loadLockSlots.filter((slot) => slot.wafer).length : module.wafers.length;
  const overflow = layerCount > visibleWaferCount ? `<span class="wafer-more">+ ${layerCount - visibleWaferCount}</span>` : "";
  const doors = moduleDoorSides(module, role, layout, roleIndex, attachmentId).map((side) => {
    const state2 = role === "lock" && (side === "top" || side === "bottom") ? module.loadLockDoors?.[side] ?? "closed" : module.door;
    const direction = role === "lock" ? side === "top" ? module.loadLockDoors?.topLabel ?? "\u771F\u7A7A\u4FA7" : module.loadLockDoors?.bottomLabel ?? "\u5927\u6C14\u4FA7" : "";
    const label = state2 === "unknown" ? "\u5F00\u95E8\u65B9\u5411\u672A\u77E5" : DOOR_LABELS[state2];
    return `<i class="external-module-door external-module-door-${side} door-${state2}" title="${escapeHtml(`${direction}${label}`)}"></i>`;
  }).join("");
  const accessibleStatus = `${module.name}\uFF0C${STATUS_LABELS[module.status]}\uFF0C${DOOR_LABELS[module.door]}`;
  const candidateLabel = candidate ? `${candidate.count} \u4E2A\u53EF\u884C\u52A8\u4F5C\uFF0C\u6700\u9AD8\u6A21\u578B\u504F\u597D ${(candidate.preference * 100).toFixed(0)}%` : "";
  if (role === "port") {
    const visibleSlot = visibleModuleSlots(module, "port").find((slot) => slot.wafer);
    const portWafers = visibleSlot ? renderWaferToken(
      visibleSlot.wafer,
      waferOrigins[visibleSlot.wafer] ?? "",
      waferProgress,
      visibleSlot.processed
    ) : "";
    return renderLoadPortTopView(module, portWafers, accessibleStatus, candidate);
  }
  if (role === "auxiliary" && isAlignerModule(module.name, module.type)) {
    return `<strong class="equipment-external-name equipment-external-name-aligner">${escapeHtml(module.name)}</strong>
      <article class="equipment-utility equipment-aligner status-${module.status} ${module.isRobotTarget ? "is-target" : ""} ${candidate ? "is-candidate-destination" : ""} ${candidate?.selected ? "is-model-selected" : ""}" aria-label="${escapeHtml(`${accessibleStatus}${candidateLabel ? `\uFF0C${candidateLabel}` : ""}`)}">
        <div class="aligner-cross ${wafers ? "is-occupied" : "is-empty"}" aria-hidden="true"><i></i><i></i>${wafers}</div>
      </article>`;
  }
  if (role === "auxiliary" && isCoolerModule(module.name, module.type)) {
    const coolerSlots = visibleModuleSlots(module, "cooler");
    const visibleSlot = coolerSlots.find((slot) => slot.wafer) ?? coolerSlots[0];
    const state2 = !visibleSlot?.wafer ? "empty" : visibleSlot.processed ? "processed" : "unprocessed";
    const label = visibleSlot?.wafer ? `${module.name}.${visibleSlot.slot}\uFF0C\u6676\u5706 ${visibleSlot.wafer}\uFF0C${visibleSlot.processed ? "\u5DF2\u52A0\u5DE5" : "\u672A\u52A0\u5DE5"}` : `${module.name}.${visibleSlot?.slot ?? 1}\uFF0C\u7A7A\u69FD`;
    const visibleWafer = visibleSlot?.wafer ? renderWaferToken(
      visibleSlot.wafer,
      waferOrigins[visibleSlot.wafer] ?? "",
      waferProgress,
      visibleSlot.processed
    ) : "";
    return `<strong class="equipment-external-name equipment-external-name-cooler">${escapeHtml(module.name)}</strong>
      <article class="equipment-utility equipment-cooler-top-view status-${module.status} ${module.isRobotTarget ? "is-target" : ""} ${candidate ? "is-candidate-destination" : ""} ${candidate?.selected ? "is-model-selected" : ""}" aria-label="${escapeHtml(`${accessibleStatus}\uFF0C\u4FEF\u89C6\u51B7\u5374\u76D8${candidateLabel ? `\uFF0C${candidateLabel}` : ""}`)}">
        <div class="cooler-top-plate" role="group" aria-label="${escapeHtml(`${module.name} \u4FEF\u89C6\u51B7\u5374\u76D8`)}"><span class="cooler-top-pocket is-${state2}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${visibleWafer}</span></div>
      </article>`;
  }
  const atmosphereLevel = role === "lock" ? module.loadLockPhase === "pumping" ? 100 - module.progress * 100 : module.loadLockPhase === "venting" ? module.progress * 100 : /大气|ATM|ATR/i.test(module.environment) ? 100 : 0 : 0;
  const loadLockLayers = role === "lock" ? (() => {
    const slots = visibleModuleSlots(module, "lock");
    const visibleSlot = slots.find((slot) => slot.wafer) ?? slots[0];
    const state2 = !visibleSlot?.wafer ? "empty" : visibleSlot.processed ? "processed" : "unprocessed";
    const label = visibleSlot?.wafer ? `${module.name}.${visibleSlot.slot}\uFF0C\u6676\u5706 ${visibleSlot.wafer}\uFF0C${visibleSlot.processed ? "\u5DF2\u52A0\u5DE5" : "\u672A\u52A0\u5DE5"}` : `${module.name}.${visibleSlot?.slot ?? 1}\uFF0C\u7A7A\u69FD`;
    const visibleWafer = visibleSlot?.wafer ? renderWaferToken(
      visibleSlot.wafer,
      waferOrigins[visibleSlot.wafer] ?? "",
      waferProgress,
      visibleSlot.processed
    ) : "";
    return `<div class="loadlock-top-chamber" role="group" aria-label="${escapeHtml(`${module.name} \u4FEF\u89C6 LoadLock`)}"><span class="loadlock-top-seat is-${state2}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${visibleWafer}</span></div>`;
  })() : role === "process" ? `<div class="process-wafer-slot ${wafers ? "is-occupied" : "is-empty"}">${wafers}</div>` : role === "auxiliary" ? `<div class="auxiliary-wafer-slot ${wafers ? "is-occupied" : "is-empty"}">${wafers}</div>` : `<div class="wafer-stack">${wafers}${overflow}</div>`;
  const bodyMarkup = role === "process" ? `<div class="equipment-process-shell"><div class="equipment-body">${loadLockLayers}</div></div>` : `<div class="equipment-body">${loadLockLayers}</div>`;
  const article = `
    <article class="equipment-card equipment-${role} status-${module.status} door-${module.door} ${module.loadLockPhase ? `loadlock-${module.loadLockPhase}` : ""} ${module.isRobotTarget ? "is-target" : ""} ${candidate ? "is-candidate-destination" : ""} ${candidate?.selected ? "is-model-selected" : ""}" style="--module-progress:${Math.round(module.progress * 100)}%;--loadlock-atmosphere:${Math.max(0, Math.min(100, atmosphereLevel)).toFixed(1)}%;--loadlock-atmosphere-ratio:${Math.max(0, Math.min(1, atmosphereLevel / 100)).toFixed(3)}" aria-label="${escapeHtml(`${accessibleStatus}${candidateLabel ? `\uFF0C${candidateLabel}` : ""}`)}">
       ${bodyMarkup}
    </article>
    <div class="external-module-doors door-${module.door}" title="${escapeHtml(DOOR_LABELS[module.door])}">${doors}</div>`;
  if (role === "process" || role === "auxiliary" || role === "lock") {
    return `<strong class="equipment-external-name">${escapeHtml(module.name)}</strong>${article}`;
  }
  return article;
}
var ROBOT_DOUBLE_HOLD_CAPACITY = 2;
var ROBOT_DISPLAY_WAFER_LIMIT = 2;
function renderRobotHub(robot, waferOrigins, environment, angleDegrees, mechanismMarkup) {
  const visibleWafers = robot.wafers.slice(0, ROBOT_DISPLAY_WAFER_LIMIT);
  const capacityLabel = robot.capacity >= ROBOT_DOUBLE_HOLD_CAPACITY ? "\u53CC\u7247\u673A\u68B0\u624B" : "\u5355\u69FD\u673A\u68B0\u624B";
  const holdingLabel = robot.wafers.length ? `\uFF0C\u6301\u6709 ${robot.wafers.length} \u7247\u6676\u5706 ${robot.wafers.join("\u3001")}` : "\uFF0C\u69FD\u4F4D\u4E3A\u7A7A";
  const waferMarkup = visibleWafers.map((wafer, index) => `
    <span class="robot-held-wafer robot-held-wafer-${index}">${renderWaferToken(wafer, waferOrigins[wafer] ?? "", 0, robot.processedWafers.includes(wafer))}</span>`).join("");
  const overflow = robot.wafers.length > ROBOT_DISPLAY_WAFER_LIMIT ? `<span class="robot-held-overflow">+${robot.wafers.length - ROBOT_DISPLAY_WAFER_LIMIT}</span>` : "";
  return `
    <article class="robot-hub robot-hub-${environment} ${robot.busy ? "is-busy" : ""}" style="--robot-arm-angle:${angleDegrees.toFixed(1)}deg" aria-label="${escapeHtml(robot.name)}\uFF0C${capacityLabel}\uFF0C${robot.busy ? "\u5DE5\u4F5C\u4E2D" : "\u5F85\u547D"}${holdingLabel}">
      <div class="robot-mechanism" aria-hidden="true">
        <span class="robot-base"><i></i></span>
        ${mechanismMarkup === void 0 ? `<span class="robot-arm">
          <i class="robot-arm-beam"></i>
          <span class="robot-end-effector ${visibleWafers.length ? "is-occupied" : "is-empty"}">
            <span class="robot-held-wafers">${waferMarkup}${overflow}</span>
          </span>
        </span>` : mechanismMarkup}
      </div>
    </article>`;
}
var TOPOLOGY_COLUMN_PERCENTAGES = [26, 42, 58, 74];
var TOPOLOGY_ROW_TOP_PIXELS = [52, 154, 256, 358, 460, 562, 664, 786, 929, 1031, 1133];
var TOPOLOGY_VIEWBOX_WIDTH = 1e3;
var TOPOLOGY_ITEM_SIZE = 96;
var TOPOLOGY_PROCESS_WIDTH = 82;
var TOPOLOGY_PROCESS_HEIGHT = 82;
var TOPOLOGY_ROBOT_SIZE = 132;
var TOPOLOGY_WAFER_OCCLUSION_RADII = { process: 24, port: 21, lock: 21, cooler: 16, aligner: 15 };
var TOPOLOGY_LOADLOCK_WIDTH = 82;
var TOPOLOGY_LOADLOCK_HEIGHT = 82;
var TOPOLOGY_LOADLOCK_BRIDGE_GAP = 2;
var TOPOLOGY_EXTERNAL_DOOR_CLEARANCE = 7;
var TOPOLOGY_CASCADE_FRAME_WIDTH = 240;
var TOPOLOGY_CASCADE_VTR1_HEIGHT = 128;
var TOPOLOGY_TIGHT_LOADLOCK_ATTACHMENT_OFFSET = (TOPOLOGY_LOADLOCK_WIDTH + 1) / TOPOLOGY_CASCADE_FRAME_WIDTH;
var TOPOLOGY_LOADPORT_WIDTH = 82;
var TOPOLOGY_LOADPORT_HEIGHT = 82;
var TOPOLOGY_ATMOSPHERE_INTERIOR_INSET = 14;
var TOPOLOGY_BUFFER_WIDTH = 104;
var TOPOLOGY_BUFFER_HEIGHT = 56;
var TOPOLOGY_COOLER_WIDTH = 76;
var TOPOLOGY_COOLER_HEIGHT = 72;
var TOPOLOGY_ALIGNER_WIDTH = 76;
var TOPOLOGY_ALIGNER_HEIGHT = 54;
var TOPOLOGY_LOADLOCK_ROW_TOP_PIXELS = [664, 740];
var TOPOLOGY_ATMOSPHERE_ROW_TOP_PIXELS = 866;
var TOPOLOGY_LOADPORT_ROW_TOP_PIXELS = 1006;
var TOPOLOGY_CANVAS_PADDING = 28;
var TOPOLOGY_MACHINE_FRAMES = {
  single: [{
    id: "vacuum-main",
    label: "VTR VACUUM FRAME",
    centerLeftPercent: 50,
    centerTopPixels: 270,
    widthPixels: 240,
    heightPixels: 240,
    shape: "square"
  }],
  dual: [{
    id: "vacuum-main",
    label: "",
    centerLeftPercent: 50,
    centerTopPixels: 270,
    widthPixels: 240,
    heightPixels: 240,
    shape: "square"
  }],
  cascade: [
    {
      id: "vacuum-vtr-2",
      label: "",
      centerLeftPercent: 50,
      centerTopPixels: 230,
      widthPixels: TOPOLOGY_CASCADE_FRAME_WIDTH,
      heightPixels: TOPOLOGY_CASCADE_FRAME_WIDTH,
      shape: "square"
    },
    {
      id: "vacuum-vtr-1",
      label: "",
      centerLeftPercent: 50,
      /* 桥接腔上下两侧均预留外置门空间。 */
      centerTopPixels: 496 + 2 * TOPOLOGY_EXTERNAL_DOOR_CLEARANCE,
      widthPixels: TOPOLOGY_CASCADE_FRAME_WIDTH,
      heightPixels: TOPOLOGY_CASCADE_VTR1_HEIGHT,
      shape: "flat"
    }
  ]
};
var TOPOLOGY_ATMOSPHERE_FRAMES = {
  single: {
    id: "atmosphere-main",
    /* 大气框架仅表达附着边界，不在框内重复显示区域名称。 */
    label: "",
    centerLeftPercent: 50,
    /* LoadLock 作为真空与大气框架之间的桥接腔。 */
    centerTopPixels: 547 + 2 * TOPOLOGY_EXTERNAL_DOOR_CLEARANCE,
    widthPixels: 425,
    heightPixels: 150,
    shape: "atmosphere"
  },
  dual: {
    id: "atmosphere-main",
    label: "",
    centerLeftPercent: 50,
    centerTopPixels: 547 + 2 * TOPOLOGY_EXTERNAL_DOOR_CLEARANCE,
    widthPixels: 425,
    heightPixels: 150,
    shape: "atmosphere"
  },
  cascade: {
    id: "atmosphere-main",
    label: "",
    centerLeftPercent: 50,
    centerTopPixels: 717 + 4 * TOPOLOGY_EXTERNAL_DOOR_CLEARANCE,
    widthPixels: 425,
    heightPixels: 150,
    shape: "atmosphere"
  }
};
var TOPOLOGY_CASCADE_LOCK_ROW_TOP = 597;
var TOPOLOGY_CASCADE_LOCK_ROW_GAP = 80;
var TOPOLOGY_CASCADE_ATM_TOP = 720;
var TOPOLOGY_ATMOSPHERE_LOADPORT_OFFSET = 140;
var TOPOLOGY_CASCADE_LOADPORT_TOP = TOPOLOGY_CASCADE_ATM_TOP + TOPOLOGY_ATMOSPHERE_LOADPORT_OFFSET;
function topologyMachineFrame(layout, index = 0) {
  return TOPOLOGY_MACHINE_FRAMES[layout][index] ?? TOPOLOGY_MACHINE_FRAMES[layout][0];
}
function topologyAtmosphereFrame(layout) {
  return TOPOLOGY_ATMOSPHERE_FRAMES[layout];
}
function topologyFrameAttachment(frame, attachmentId, side, offset, widthPixels, heightPixels) {
  const halfWidthPercent = widthPixels / TOPOLOGY_VIEWBOX_WIDTH * 50;
  const frameWidthPercent = frame.widthPixels / TOPOLOGY_VIEWBOX_WIDTH * 100;
  if (side === "center") {
    return {
      leftPercent: frame.centerLeftPercent,
      topPixels: frame.centerTopPixels,
      widthPixels,
      heightPixels,
      attachmentId,
      fixedLeftOffsetPixels: 0
    };
  }
  const horizontalOffset = offset * frameWidthPercent / 2;
  const verticalOffset = offset * frame.heightPixels / 2;
  return {
    leftPercent: side === "left" ? frame.centerLeftPercent - frameWidthPercent / 2 - halfWidthPercent - TOPOLOGY_EXTERNAL_DOOR_CLEARANCE / TOPOLOGY_VIEWBOX_WIDTH * 100 : side === "right" ? frame.centerLeftPercent + frameWidthPercent / 2 + halfWidthPercent + TOPOLOGY_EXTERNAL_DOOR_CLEARANCE / TOPOLOGY_VIEWBOX_WIDTH * 100 : frame.centerLeftPercent + horizontalOffset,
    topPixels: Math.round(side === "top" ? frame.centerTopPixels - frame.heightPixels / 2 - heightPixels / 2 - TOPOLOGY_EXTERNAL_DOOR_CLEARANCE : side === "bottom" ? frame.centerTopPixels + frame.heightPixels / 2 + heightPixels / 2 + TOPOLOGY_EXTERNAL_DOOR_CLEARANCE : frame.centerTopPixels + verticalOffset),
    widthPixels,
    heightPixels,
    attachmentId,
    fixedLeftOffsetPixels: side === "left" ? -frame.widthPixels / 2 - widthPixels / 2 - TOPOLOGY_EXTERNAL_DOOR_CLEARANCE : side === "right" ? frame.widthPixels / 2 + widthPixels / 2 + TOPOLOGY_EXTERNAL_DOOR_CLEARANCE : horizontalOffset / 100 * TOPOLOGY_VIEWBOX_WIDTH
  };
}
function topologyVacuumAtmosphereLoadLockBridge(layout, lockIndex, atmosphereOffset) {
  const vacuumFrame = layout === "cascade" ? topologyMachineFrame("cascade", 1) : topologyMachineFrame(layout);
  const atmosphereFrame = topologyAtmosphereFrame(layout);
  const vacuumOffset = atmosphereOffset * atmosphereFrame.widthPixels / vacuumFrame.widthPixels;
  const vacuumAttachment = topologyFrameAttachment(
    vacuumFrame,
    `${vacuumFrame.id}-loadlock-${lockIndex + 1}@bottom`,
    "bottom",
    vacuumOffset,
    TOPOLOGY_LOADLOCK_WIDTH,
    TOPOLOGY_LOADLOCK_HEIGHT
  );
  const atmosphereAttachment = topologyFrameAttachment(
    atmosphereFrame,
    `${atmosphereFrame.id}-loadlock-${lockIndex + 1}@top`,
    "top",
    atmosphereOffset,
    TOPOLOGY_LOADLOCK_WIDTH,
    TOPOLOGY_LOADLOCK_HEIGHT
  );
  return {
    ...vacuumAttachment,
    /* 两端框架的中心距由常量固定；保留大气锚点的纵坐标以表达两侧相同的门条间距。 */
    topPixels: atmosphereAttachment.topPixels,
    attachmentId: `${vacuumAttachment.attachmentId}|${atmosphereAttachment.attachmentId}`
  };
}
function topologyTightLoadLockOffsets(count, frameWidthPixels) {
  if (count <= 1) return [0];
  const centerSpacing = TOPOLOGY_LOADLOCK_WIDTH + TOPOLOGY_LOADLOCK_BRIDGE_GAP;
  const offsetStep = centerSpacing / (frameWidthPixels / 2);
  return Array.from(
    { length: count },
    (_, index) => (index - (count - 1) / 2) * offsetStep
  );
}
function topologyFrameUpperUtilityAttachment(frame, attachmentId, horizontal, widthPixels, heightPixels) {
  const horizontalOffset = frame.widthPixels / 2 - TOPOLOGY_ATMOSPHERE_INTERIOR_INSET - widthPixels / 2;
  return {
    leftPercent: frame.centerLeftPercent + (horizontal === "left" ? -horizontalOffset : horizontalOffset) / TOPOLOGY_VIEWBOX_WIDTH * 100,
    topPixels: frame.centerTopPixels - frame.heightPixels / 2 - heightPixels / 2 - TOPOLOGY_LOADLOCK_BRIDGE_GAP,
    widthPixels,
    heightPixels,
    attachmentId,
    fixedLeftOffsetPixels: horizontal === "left" ? -horizontalOffset : horizontalOffset
  };
}
function distributedTopologyColumns(count) {
  if (count <= 1) return [50];
  if (count === 2) return [40, 60];
  if (count === 3) return [30, 50, 70];
  return Array.from({ length: count }, (_, index) => 20 + index * 60 / (count - 1));
}
function isMultiProcessChamberType(value) {
  const type = String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  return type.includes("multiprocesschamber") || (type.includes("multi") || type.includes("dual") || type.includes("double")) && (type.includes("process") || type.includes("chamber"));
}
function detectTopologyLayout(modules, robotCount) {
  if (robotCount > 2) return "cascade";
  const hasMultiProcessChamber = modules.some((module) => isMultiProcessChamberType(module.type));
  return hasMultiProcessChamber ? "dual" : "single";
}
function detectDeviceTopologyLayout(device) {
  const robotCount = Object.keys(device?.Robots ?? {}).length;
  if (robotCount > 2) return "cascade";
  const hasMultiProcessChamber = Object.values(device?.Stations ?? {}).some((station2) => {
    const type = String(station2.Type ?? "");
    return isMultiProcessChamberType(type) || /process|chamber/i.test(type) && finiteNumber(station2.Capacity, 1) > 1;
  });
  return hasMultiProcessChamber ? "dual" : "single";
}
function configurationReferencesName(value, name) {
  if (typeof value === "string") return value === name;
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => configurationReferencesName(item, name));
  return Object.entries(value).some(([key, item]) => key === name || configurationReferencesName(item, name));
}
function cascadeBridgeLoadLockNames(orderedLoadLockNames, device, vacuumRobotNames) {
  const structurallyLinked = orderedLoadLockNames.filter((loadLockName) => {
    const station2 = device?.Stations?.[loadLockName];
    const linkedVacuumRobots = vacuumRobotNames.filter((robotName) => configurationReferencesName(station2, robotName) || configurationReferencesName(device?.Robots?.[robotName], loadLockName));
    return linkedVacuumRobots.length >= 2;
  });
  if (structurallyLinked.length) return new Set(structurallyLinked);
  const namedBridges = orderedLoadLockNames.filter((name) => /^(?:UBR|DBR)(?:[_-]?\d+)?$/i.test(name.trim())).sort((left, right) => {
    const rank = (name) => /^UBR/i.test(name.trim()) ? 0 : 1;
    return rank(left) - rank(right) || naturalCompare(left, right);
  });
  return new Set(namedBridges.length ? namedBridges : orderedLoadLockNames.slice(4));
}
function moduleTopologyPosition(module, role, index, roleModules, layout, bridgeLoadLockNames = /* @__PURE__ */ new Set()) {
  const name = module.name.trim().toUpperCase();
  const roleCount = roleModules.length;
  const column = TOPOLOGY_COLUMN_PERCENTAGES;
  const row = TOPOLOGY_ROW_TOP_PIXELS;
  if (layout === "cascade" && role === "process") {
    const ordered = [...roleModules].filter((item) => !isHeaterModule(item.name, item.type)).sort((left, right) => naturalCompare(left.name, right.name));
    const layoutIndex = Math.max(0, ordered.findIndex((item) => item.name === module.name));
    const upperFrame = topologyMachineFrame("cascade", 0);
    const lowerFrame = topologyMachineFrame("cascade", 1);
    const positions = [
      topologyFrameAttachment(lowerFrame, "vtr-1-process-left@left", "left", 0, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT),
      topologyFrameAttachment(lowerFrame, "vtr-1-process-right@right", "right", 0, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT),
      topologyFrameAttachment(upperFrame, "vtr-2-process-left-lower@left", "left", 0.55, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT),
      topologyFrameAttachment(upperFrame, "vtr-2-process-top-left@top", "top", -0.45, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT),
      topologyFrameAttachment(upperFrame, "vtr-2-process-right-upper@right", "right", -0.45, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT)
    ];
    const position = positions[layoutIndex] ?? {
      leftPercent: distributedTopologyColumns(roleCount)[layoutIndex] ?? 50,
      topPixels: TOPOLOGY_ROW_TOP_PIXELS[0] - Math.floor(layoutIndex / Math.max(roleCount, 1)) * 112
    };
    return { ...position, widthPixels: TOPOLOGY_PROCESS_WIDTH, heightPixels: TOPOLOGY_PROCESS_HEIGHT };
  }
  if (layout === "dual" && role === "process") {
    const dualBaseName = module.name.replace(/-\d+$/, "");
    const dualSlotIndex = Math.max(0, Number(/-(\d+)$/.exec(module.name)?.[1] ?? "1") - 1);
    const dualBaseNames = [...new Set(roleModules.map((item) => item.name.replace(/-\d+$/, "")))].sort(naturalCompare);
    const dualBaseIndex = Math.max(0, dualBaseNames.indexOf(dualBaseName));
    const frame = topologyMachineFrame("dual");
    const dualLayout = [
      [
        topologyFrameAttachment(frame, "dual-pm1-upper@left", "left", -0.38, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT),
        topologyFrameAttachment(frame, "dual-pm1-lower@left", "left", 0.38, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT)
      ],
      [
        topologyFrameAttachment(frame, "dual-pm2-left@top", "top", -0.5, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT),
        topologyFrameAttachment(frame, "dual-pm2-right@top", "top", 0.5, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT)
      ],
      [
        topologyFrameAttachment(frame, "dual-pm3-upper@right", "right", -0.38, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT),
        topologyFrameAttachment(frame, "dual-pm3-lower@right", "right", 0.38, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT)
      ]
    ];
    const position = dualLayout[dualBaseIndex]?.[dualSlotIndex] ?? {
      leftPercent: distributedTopologyColumns(roleCount)[dualBaseIndex] ?? 50,
      topPixels: TOPOLOGY_ROW_TOP_PIXELS[3]
    };
    return { ...position, widthPixels: TOPOLOGY_PROCESS_WIDTH, heightPixels: TOPOLOGY_PROCESS_HEIGHT };
  }
  if (role === "process") {
    const frame = topologyMachineFrame("single");
    if (isHeaterModule(module.name, module.type)) {
      return topologyFrameAttachment(
        frame,
        "single-heater-top-left@top",
        "top",
        -0.5,
        TOPOLOGY_PROCESS_WIDTH,
        TOPOLOGY_PROCESS_HEIGHT
      );
    }
    const ordered = [...roleModules].filter((item) => !isHeaterModule(item.name, item.type)).sort((left, right) => naturalCompare(left.name, right.name));
    const layoutIndex = Math.max(0, ordered.findIndex((item) => item.name === module.name));
    const positions = [
      topologyFrameAttachment(frame, "single-process-left-upper@left", "left", -0.32, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT),
      topologyFrameAttachment(frame, "single-process-left-lower@left", "left", 0.48, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT),
      topologyFrameAttachment(frame, "single-process-right-upper@right", "right", -0.32, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT),
      topologyFrameAttachment(frame, "single-process-right-lower@right", "right", 0.48, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT)
    ];
    const position = positions[layoutIndex] ?? {
      leftPercent: distributedTopologyColumns(roleCount)[layoutIndex] ?? 50,
      topPixels: TOPOLOGY_ROW_TOP_PIXELS[3]
    };
    return { ...position, widthPixels: TOPOLOGY_PROCESS_WIDTH, heightPixels: TOPOLOGY_PROCESS_HEIGHT };
  }
  if (layout === "cascade" && role === "lock" && bridgeLoadLockNames.has(module.name)) {
    const orderedBridges = [...bridgeLoadLockNames];
    const bridgeIndex = Math.max(0, orderedBridges.indexOf(module.name));
    return topologyFrameAttachment(
      topologyMachineFrame("cascade", 0),
      bridgeIndex % 2 === 0 ? "cascade-bridge-left" : "cascade-bridge-right",
      "bottom",
      bridgeIndex % 2 === 0 ? -TOPOLOGY_TIGHT_LOADLOCK_ATTACHMENT_OFFSET : TOPOLOGY_TIGHT_LOADLOCK_ATTACHMENT_OFFSET,
      TOPOLOGY_LOADLOCK_WIDTH,
      TOPOLOGY_LOADLOCK_HEIGHT
    );
  }
  if (role === "lock") {
    const canonicalOrder = layout === "dual" ? { LC: 0, LA: 1, LB: 2, LD: 3 } : { LA: 0, LB: 1, LC: 2, LD: 3 };
    const atmosphereLoadLocks = layout === "cascade" ? roleModules.filter((item) => !bridgeLoadLockNames.has(item.name)) : roleModules;
    const orderedLoadLocks = [...atmosphereLoadLocks].sort((left, right) => {
      const leftName = left.name.trim().toUpperCase();
      const rightName = right.name.trim().toUpperCase();
      const leftRank = canonicalOrder[leftName] ?? 100;
      const rightRank = canonicalOrder[rightName] ?? 100;
      return leftRank - rightRank || naturalCompare(left.name, right.name);
    });
    const gridIndex = Math.max(0, orderedLoadLocks.findIndex((item) => item.name === module.name));
    if ((layout === "single" || layout === "dual" || layout === "cascade") && gridIndex < 4) {
      const atmosphereLockCount = orderedLoadLocks.length;
      const offsets = topologyTightLoadLockOffsets(
        atmosphereLockCount,
        topologyAtmosphereFrame(layout).widthPixels
      );
      return topologyVacuumAtmosphereLoadLockBridge(
        layout,
        gridIndex,
        offsets[gridIndex] ?? 0
      );
    }
    const loadLockRowTop = layout === "cascade" ? TOPOLOGY_CASCADE_LOCK_ROW_TOP : TOPOLOGY_LOADLOCK_ROW_TOP_PIXELS[0];
    const loadLockRowGap = layout === "cascade" ? TOPOLOGY_CASCADE_LOCK_ROW_GAP : TOPOLOGY_LOADLOCK_ROW_TOP_PIXELS[1] - TOPOLOGY_LOADLOCK_ROW_TOP_PIXELS[0];
    return {
      leftPercent: gridIndex % 2 === 0 ? 40 : 60,
      topPixels: loadLockRowTop + Math.floor(gridIndex / 2) * loadLockRowGap,
      widthPixels: TOPOLOGY_LOADLOCK_WIDTH,
      heightPixels: TOPOLOGY_LOADLOCK_HEIGHT
    };
  }
  if (role === "port") {
    const canonicalOrder = { LP1: 0, LP2: 1, LP3: 2, LP4: 3 };
    const orderedPorts = [...roleModules].sort((left, right) => {
      const leftDummy = isDummyPortName(left.name) || left.type.trim().toLowerCase() === "dummyport";
      const rightDummy = isDummyPortName(right.name) || right.type.trim().toLowerCase() === "dummyport";
      if (leftDummy !== rightDummy) return leftDummy ? 1 : -1;
      const leftRank = canonicalOrder[left.name.trim().toUpperCase()] ?? 100;
      const rightRank = canonicalOrder[right.name.trim().toUpperCase()] ?? 100;
      return leftRank - rightRank || naturalCompare(left.name, right.name);
    });
    const portIndex = Math.max(0, orderedPorts.findIndex((item) => item.name === module.name));
    if (portIndex < 4) {
      const offsets = orderedPorts.length <= 1 ? [0] : orderedPorts.length === 2 ? [-0.3, 0.3] : orderedPorts.length === 3 ? [-0.6, 0, 0.6] : [-0.7, -0.233, 0.233, 0.7];
      return topologyFrameAttachment(
        topologyAtmosphereFrame(layout),
        `atmosphere-port-${portIndex + 1}@bottom`,
        "bottom",
        offsets[portIndex] ?? 0,
        TOPOLOGY_LOADPORT_WIDTH,
        TOPOLOGY_LOADPORT_HEIGHT
      );
    }
    const portColumns = roleCount === 5 ? [26, 38, 50, 62, 74] : roleCount <= column.length ? column : Array.from({ length: roleCount }, (_, current) => 20 + current * 60 / (roleCount - 1));
    const loadPortTop = layout === "cascade" ? TOPOLOGY_CASCADE_LOADPORT_TOP : TOPOLOGY_LOADPORT_ROW_TOP_PIXELS;
    return {
      leftPercent: portColumns[portIndex] ?? column[0],
      topPixels: loadPortTop,
      widthPixels: TOPOLOGY_LOADPORT_WIDTH,
      heightPixels: TOPOLOGY_LOADPORT_HEIGHT
    };
  }
  if (isAlignerModule(module.name, module.type)) {
    if (layout === "dual") return topologyFrameAttachment(
      topologyAtmosphereFrame(layout),
      "atmosphere-aligner@left",
      "left",
      0,
      TOPOLOGY_ALIGNER_WIDTH,
      TOPOLOGY_ALIGNER_HEIGHT
    );
    return topologyFrameUpperUtilityAttachment(
      topologyAtmosphereFrame(layout),
      "atmosphere-aligner-top-left@top",
      "left",
      TOPOLOGY_ALIGNER_WIDTH,
      TOPOLOGY_ALIGNER_HEIGHT
    );
  }
  if (role === "auxiliary" && isCoolerModule(module.name, module.type)) {
    if (layout === "dual") return topologyFrameAttachment(
      topologyAtmosphereFrame(layout),
      "atmosphere-cooler@right",
      "right",
      0,
      TOPOLOGY_COOLER_WIDTH,
      TOPOLOGY_COOLER_HEIGHT
    );
    return topologyFrameUpperUtilityAttachment(
      topologyAtmosphereFrame(layout),
      "atmosphere-cooler-top-right@top",
      "right",
      TOPOLOGY_COOLER_WIDTH,
      TOPOLOGY_COOLER_HEIGHT
    );
  }
  if (role === "auxiliary" && isBufferModule(module.name, module.type)) {
    const atmosphereTop = layout === "cascade" ? TOPOLOGY_CASCADE_ATM_TOP : TOPOLOGY_ATMOSPHERE_ROW_TOP_PIXELS;
    const rightUtilities = roleModules.filter((item) => isBufferModule(item.name, item.type)).sort((left, right) => naturalCompare(left.name, right.name));
    const utilityIndex = Math.max(0, rightUtilities.findIndex((item) => item.name === module.name));
    const utilityTop = atmosphereTop + utilityIndex * 68;
    return {
      leftPercent: 90,
      topPixels: utilityTop,
      widthPixels: TOPOLOGY_BUFFER_WIDTH,
      heightPixels: TOPOLOGY_BUFFER_HEIGHT
    };
  }
  if (role === "auxiliary") {
    const perRow = 6;
    const rowIndex = Math.floor(index / perRow);
    const columnIndex = index % perRow;
    const columnsInRow = Math.max(1, Math.min(perRow, roleCount - rowIndex * perRow));
    const rowGap = row[1] - row[0];
    return {
      leftPercent: distributedTopologyColumns(columnsInRow)[columnIndex] ?? 50,
      topPixels: TOPOLOGY_LOADPORT_ROW_TOP_PIXELS + row[1] - row[0] + rowIndex * rowGap
    };
  }
  const fallbackRow = role === "process" ? row[3] : row[7];
  return {
    leftPercent: distributedTopologyColumns(Math.max(roleCount, 1))[index] ?? 50,
    topPixels: fallbackRow,
    ...role === "process" ? { widthPixels: TOPOLOGY_PROCESS_WIDTH, heightPixels: TOPOLOGY_PROCESS_HEIGHT } : {}
  };
}
function robotTopologyPosition(robotIndex, robotCount, environment, layout) {
  if (environment === "atmosphere") {
    const atmosphereFrame = topologyAtmosphereFrame(layout);
    if (robotCount > 1) {
      return {
        leftPercent: distributedTopologyColumns(robotCount)[robotIndex] ?? 50,
        topPixels: atmosphereFrame.centerTopPixels,
        widthPixels: TOPOLOGY_ROBOT_SIZE,
        heightPixels: TOPOLOGY_ROBOT_SIZE
      };
    }
    return topologyFrameAttachment(
      atmosphereFrame,
      "atr-center",
      "center",
      0,
      TOPOLOGY_ROBOT_SIZE,
      TOPOLOGY_ROBOT_SIZE
    );
  }
  if (layout === "cascade") {
    const frame = topologyMachineFrame("cascade", robotIndex === 0 ? 1 : 0);
    return topologyFrameAttachment(
      frame,
      robotIndex === 0 ? "vtr-1-center" : `vtr-2-center-${robotIndex}`,
      "center",
      0,
      TOPOLOGY_ROBOT_SIZE,
      TOPOLOGY_ROBOT_SIZE
    );
  }
  if (layout === "dual") {
    return topologyFrameAttachment(
      topologyMachineFrame("dual"),
      "dual-robot-center",
      "center",
      0,
      TOPOLOGY_ROBOT_SIZE,
      TOPOLOGY_ROBOT_SIZE
    );
  }
  return topologyFrameAttachment(
    topologyMachineFrame("single"),
    "single-robot-center",
    "center",
    0,
    TOPOLOGY_ROBOT_SIZE,
    TOPOLOGY_ROBOT_SIZE
  );
}
function interpolatedRobotAngle(start, end, progress) {
  let delta = (end - start) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return start + delta * Math.max(0, Math.min(1, progress));
}
function robotLoadLockPortal(robotName, moduleName, modulePositions, environment) {
  const normalizedModule = moduleName.trim().toUpperCase();
  const isAtmosphereRobot = environment ? environment === "atmosphere" : /^(ATR|ATM)/i.test(robotName);
  const isVacuumRobot = environment ? environment === "vacuum" : /^(VTR|VTM|VAC)/i.test(robotName);
  if (!isAtmosphereRobot && !isVacuumRobot) return moduleName;
  const preferred = ["LA", "LC"].includes(normalizedModule) ? isAtmosphereRobot ? "LC" : "LA" : ["LB", "LD"].includes(normalizedModule) ? isAtmosphereRobot ? "LD" : "LB" : moduleName;
  return modulePositions.has(preferred) ? preferred : moduleName;
}
function robotTargetTopologyPosition(robot, moduleName, modulePositions) {
  const normalizedModule = moduleName.trim().toUpperCase();
  if (robot.environment === "vacuum" && ["LA", "LB"].includes(normalizedModule)) {
    const leftLoadLock = modulePositions.get("LA");
    const rightLoadLock = modulePositions.get("LB");
    if (leftLoadLock && rightLoadLock) {
      return {
        leftPercent: (leftLoadLock.leftPercent + rightLoadLock.leftPercent) / 2,
        topPixels: (leftLoadLock.topPixels + rightLoadLock.topPixels) / 2,
        widthPixels: 0,
        heightPixels: 0
      };
    }
  }
  const portal = robotLoadLockPortal(robot.name, moduleName, modulePositions, robot.environment);
  return modulePositions.get(portal);
}
function selectedDecisionCandidate(decision) {
  if (!decision) return null;
  return decision.candidates.find((candidate) => candidate.selected) ?? decision.candidates.find((candidate) => candidate.actionId === decision.selectedActionId) ?? decision.candidates.find((candidate) => candidate.executed) ?? null;
}
function decisionTargetForRobot(robot, decision) {
  const candidate = selectedDecisionCandidate(decision);
  if (!candidate || candidate.robot !== robot.name) return "";
  if (candidate.source === robot.name) return candidate.destination;
  if (candidate.destination === robot.name) return candidate.source;
  return candidate.destination || candidate.source;
}
function isModuleFilteredOut(module, hiddenFilters) {
  if (!hiddenFilters?.size) return false;
  const normalized = module.name.trim().toUpperCase();
  const type = module.type.trim().toLowerCase();
  return hiddenFilters.has("aligner") && (/^(AL|ALIGNER)$/.test(normalized) || type === "aligner") || hiddenFilters.has("cooler") && (/^(CL|COOL(?:ER)?)$/.test(normalized) || type === "cooler");
}
function renderEquipmentTopology(snapshot, decision, hiddenFilters, device) {
  const layout = device ? detectDeviceTopologyLayout(device) : detectTopologyLayout(snapshot.modules, snapshot.robots.length);
  const projection = projectTopologyTransfers(snapshot, device);
  const visibleModules = projection.modules.filter((module) => !isTopologyHiddenModule(module) && !isModuleFilteredOut(module, hiddenFilters));
  const groups = topologyGroups(visibleModules);
  const destinations = candidateDestinations(decision);
  const atmosphereRobots = snapshot.robots.filter((robot) => robot.environment === "atmosphere" || !robot.environment && /^(ATR|ATM)/i.test(robot.name));
  const atmosphereNames = new Set(atmosphereRobots.map((robot) => robot.name));
  const vacuumRobots = snapshot.robots.filter((robot) => !atmosphereNames.has(robot.name));
  const machineFrames = TOPOLOGY_MACHINE_FRAMES[layout].map((frame) => ({ ...frame }));
  const processChamberViews = layout === "dual" ? expandDualProcessChambers(groups.processModules) : groups.processModules.map((module) => ({ view: module, sourceName: module.name }));
  const processSourceNames = new Map(processChamberViews.map((item) => [item.view.name, item.sourceName]));
  const loadLockNameSet = new Set(groups.loadLocks.map((module) => module.name));
  const configuredLoadLockOrder = Object.keys(device?.Stations ?? {}).filter((name) => loadLockNameSet.has(name));
  const orderedLoadLockNames = configuredLoadLockOrder.length === groups.loadLocks.length ? configuredLoadLockOrder : groups.loadLocks.map((module) => module.name);
  const bridgeLoadLockNames = layout === "cascade" ? cascadeBridgeLoadLockNames(
    orderedLoadLockNames,
    device,
    vacuumRobots.map((robot) => robot.name)
  ) : /* @__PURE__ */ new Set();
  const modulePositions = /* @__PURE__ */ new Map();
  const positionModuleGroup = (modules, role) => modules.forEach((module, index) => {
    const position = moduleTopologyPosition(module, role, index, modules, layout, bridgeLoadLockNames);
    modulePositions.set(module.name, position);
  });
  positionModuleGroup(processChamberViews.map((item) => item.view), "process");
  positionModuleGroup(groups.loadLocks, "lock");
  positionModuleGroup(groups.loadPorts, "port");
  positionModuleGroup(groups.auxiliaryModules, "auxiliary");
  if (layout === "dual") {
    for (const item of processChamberViews) {
      if (item.view.name === item.sourceName) continue;
      const first = modulePositions.get(`${item.sourceName}-1`);
      const second = modulePositions.get(`${item.sourceName}-2`);
      if (first && second) {
        modulePositions.set(item.sourceName, {
          leftPercent: (first.leftPercent + second.leftPercent) / 2,
          topPixels: (first.topPixels + second.topPixels) / 2,
          widthPixels: TOPOLOGY_PROCESS_WIDTH,
          heightPixels: TOPOLOGY_PROCESS_HEIGHT
        });
      }
    }
  }
  const robotPositions = /* @__PURE__ */ new Map();
  const positionRobotGroup = (robots, environment) => robots.forEach((robot, index) => {
    const position = robotTopologyPosition(index, robots.length, environment, layout);
    robotPositions.set(robot.name, position);
  });
  positionRobotGroup(vacuumRobots, "vacuum");
  positionRobotGroup(atmosphereRobots, "atmosphere");
  const atmosphereFrame = { ...topologyAtmosphereFrame(layout) };
  const allPositions = [
    ...modulePositions.values(),
    ...robotPositions.values(),
    ...machineFrames.map((frame) => ({
      leftPercent: frame.centerLeftPercent,
      topPixels: frame.centerTopPixels,
      widthPixels: frame.widthPixels,
      heightPixels: frame.heightPixels
    })),
    {
      leftPercent: atmosphereFrame.centerLeftPercent,
      topPixels: atmosphereFrame.centerTopPixels,
      widthPixels: atmosphereFrame.widthPixels,
      heightPixels: atmosphereFrame.heightPixels
    }
  ];
  const minimumTop = allPositions.length ? Math.min(...allPositions.map((position) => position.topPixels - (position.heightPixels ?? TOPOLOGY_ITEM_SIZE) / 2)) : 0;
  const maximumBottom = allPositions.length ? Math.max(...allPositions.map((position) => position.topPixels + (position.heightPixels ?? TOPOLOGY_ITEM_SIZE) / 2)) : TOPOLOGY_ITEM_SIZE;
  const verticalOffset = TOPOLOGY_CANVAS_PADDING - minimumTop;
  let canvasHeight = Math.max(
    520,
    Math.ceil(maximumBottom + verticalOffset + TOPOLOGY_CANVAS_PADDING)
  );
  for (const [name, position] of modulePositions) {
    modulePositions.set(name, { ...position, topPixels: position.topPixels + verticalOffset });
  }
  for (const [name, position] of robotPositions) {
    robotPositions.set(name, { ...position, topPixels: position.topPixels + verticalOffset });
  }
  machineFrames.forEach((frame) => {
    frame.centerTopPixels += verticalOffset;
  });
  atmosphereFrame.centerTopPixels += verticalOffset;
  const machineAreaMarkup = "";
  const machineFrameMarkup = [...machineFrames, atmosphereFrame].map((frame) => {
    const frameAnchors = ["top", "right", "bottom", "left"].flatMap((edge) => [1, 2].map((index) => `<i class="topology-frame-anchor topology-frame-anchor-${edge} topology-frame-anchor-${index}" data-anchor-id="${escapeHtml(frame.id)}-${edge}-${index}" data-anchor-edge="${edge}" aria-hidden="true"></i>`)).join("");
    return `
    <div class="topology-machine-frame topology-machine-frame-${frame.shape}" data-frame-id="${escapeHtml(frame.id)}" style="--frame-left:${frame.centerLeftPercent}%;--frame-top:${frame.centerTopPixels}px;--frame-width:${frame.widthPixels}px;--frame-height:${frame.heightPixels}px" aria-hidden="true">
      ${frame.label ? `<span>${escapeHtml(frame.label)}</span>` : ""}
      ${frameAnchors}
    </div>`;
  }).join("");
  const attachmentPointMarkup = [...modulePositions.values(), ...robotPositions.values()].filter((position) => position.attachmentId).map((position) => `<i class="topology-attachment-point" data-attachment-id="${escapeHtml(position.attachmentId ?? "")}" style="--attachment-left:${position.leftPercent}%;--attachment-top:${position.topPixels}px" aria-hidden="true"></i>`).join("");
  const renderModuleGroup = (modules, role) => modules.map((module, roleIndex) => {
    const position = modulePositions.get(module.name);
    if (!position) return "";
    const candidateSource = processSourceNames.get(module.name) ?? module.name;
    const fixedLeft = position.fixedLeftOffsetPixels === void 0 ? "" : `;--fixed-left:calc(50% ${position.fixedLeftOffsetPixels < 0 ? "-" : "+"} ${Math.abs(position.fixedLeftOffsetPixels)}px)`;
    return `<div class="reference-module-position" style="--module-left:${position.leftPercent}%;--module-top:${position.topPixels}px${fixedLeft}">${renderModule(module, snapshot.waferOrigins, role, destinations.get(candidateSource), layout, roleIndex, position.attachmentId)}</div>`;
  }).join("");
  const moduleMarkup = [
    renderModuleGroup(processChamberViews.map((item) => item.view), "process"),
    renderModuleGroup(groups.loadLocks, "lock"),
    renderModuleGroup(groups.loadPorts, "port"),
    renderModuleGroup(groups.auxiliaryModules, "auxiliary")
  ].join("");
  const renderRobotGroup = (robots, environment) => robots.map((robot) => {
    const originalPosition = robotPositions.get(robot.name);
    if (!originalPosition) return "";
    const position = { ...originalPosition };
    if (environment === "atmosphere" && robot.railMotion?.target) {
      const motion = robot.railMotion;
      const source = modulePositions.get(motion.source);
      const destination = modulePositions.get(motion.target);
      const sourceX = source?.fixedLeftOffsetPixels ?? (source ? (source.leftPercent - 50) / 100 * TOPOLOGY_VIEWBOX_WIDTH : 0);
      const destinationX = destination?.fixedLeftOffsetPixels ?? (destination ? (destination.leftPercent - 50) / 100 * TOPOLOGY_VIEWBOX_WIDTH : sourceX);
      const progress = motion.progress * motion.progress * (3 - 2 * motion.progress);
      const offset = sourceX + (destinationX - sourceX) * progress;
      position.fixedLeftOffsetPixels = offset;
      position.leftPercent = 50 + offset / TOPOLOGY_VIEWBOX_WIDTH * 100;
    }
    const activeMove = snapshot.activeMoves.find((move) => move.ModuleName === robot.name);
    const transferring = activeMove && (PICK_MOVE_TYPES.has(activeMove.MoveType) || PLACE_MOVE_TYPES.has(activeMove.MoveType) || activeMove.MoveType === SWAP_MOVE2);
    const target = robot.target || decisionTargetForRobot(robot, decision);
    const pairedLoadLock = (station2) => layout === "dual" && environment === "vacuum" && /^(LA|LB|LC|LD)$/i.test(station2) && Boolean(activeMove) && ["RobotSlotList", "RecvSlotList", "SendSlotList"].some((field) => listValue(activeMove?.[field]).length >= 2);
    const transferPosition = (station2) => pairedLoadLock(station2) ? robotTargetTopologyPosition(robot, "LA", modulePositions) : modulePositions.get(station2);
    const targetPosition = transferring ? transferPosition(target) : robotTargetTopologyPosition(robot, target, modulePositions);
    const targetAngle = targetPosition ? Math.atan2(
      targetPosition.topPixels - position.topPixels,
      targetPosition.leftPercent / 100 * TOPOLOGY_VIEWBOX_WIDTH - position.leftPercent / 100 * TOPOLOGY_VIEWBOX_WIDTH
    ) : -Math.PI / 2;
    let armAngle = targetAngle;
    if (robot.isPreTrans && robot.source) {
      const sourcePortal = robotLoadLockPortal(robot.name, robot.source, modulePositions, robot.environment);
      const sourcePosition = modulePositions.get(sourcePortal);
      if (sourcePosition) {
        const sourceAngle = Math.atan2(
          sourcePosition.topPixels - position.topPixels,
          sourcePosition.leftPercent / 100 * TOPOLOGY_VIEWBOX_WIDTH - position.leftPercent / 100 * TOPOLOGY_VIEWBOX_WIDTH
        );
        armAngle = interpolatedRobotAngle(sourceAngle, targetAngle, robot.preTransProgress);
      }
    }
    const angleDegrees = armAngle * 180 / Math.PI;
    const distance = targetPosition ? Math.hypot(
      targetPosition.topPixels - position.topPixels,
      (targetPosition.leftPercent - position.leftPercent) / 100 * TOPOLOGY_VIEWBOX_WIDTH
    ) : 0;
    const mechanism = renderParallelRobotArms(
      projection.animations.get(robot.name) ?? [],
      distance,
      (wafer) => `<span class="robot-held-wafer robot-held-wafer-0">${renderWaferToken(
        wafer,
        snapshot.waferOrigins[wafer] ?? "",
        0,
        robot.processedWafers.includes(wafer) || snapshot.modules.some((module) => module.processedWafers.includes(wafer))
      )}</span>`,
      escapeHtml,
      (station2) => {
        const target2 = transferPosition(station2);
        if (!target2) return void 0;
        const dx = (target2.leftPercent - position.leftPercent) / 100 * TOPOLOGY_VIEWBOX_WIDTH;
        const dy = target2.topPixels - position.topPixels;
        const firstChamber = modulePositions.get(pairedLoadLock(station2) ? "LA" : `${station2}-1`);
        const secondChamber = modulePositions.get(pairedLoadLock(station2) ? "LB" : `${station2}-2`);
        const targetRadians = Math.atan2(dy, dx);
        const slotSpacing = firstChamber && secondChamber ? -(secondChamber.leftPercent - firstChamber.leftPercent) / 100 * TOPOLOGY_VIEWBOX_WIDTH * Math.sin(targetRadians) + (secondChamber.topPixels - firstChamber.topPixels) * Math.cos(targetRadians) : void 0;
        return { distance: Math.hypot(dx, dy), angle: targetRadians * 180 / Math.PI - angleDegrees, slotSpacing };
      },
      [...processChamberViews.map((item) => item.view), ...groups.loadLocks, ...groups.loadPorts, ...groups.auxiliaryModules].filter((module) => module.wafers.length > 0).flatMap((module) => {
        const location = modulePositions.get(module.name);
        if (!location) return [];
        const dx = (location.leftPercent - position.leftPercent) / 100 * TOPOLOGY_VIEWBOX_WIDTH;
        const dy = location.topPixels - position.topPixels;
        const type = module.type.toLowerCase();
        const radius = type.includes("loadport") || type.includes("dummyport") ? TOPOLOGY_WAFER_OCCLUSION_RADII.port : type.includes("loadlock") ? TOPOLOGY_WAFER_OCCLUSION_RADII.lock : type.includes("cooler") ? TOPOLOGY_WAFER_OCCLUSION_RADII.cooler : type.includes("aligner") ? TOPOLOGY_WAFER_OCCLUSION_RADII.aligner : TOPOLOGY_WAFER_OCCLUSION_RADII.process;
        return [{ x: dx * Math.cos(armAngle) + dy * Math.sin(armAngle), y: -dx * Math.sin(armAngle) + dy * Math.cos(armAngle), radius }];
      }),
      robot.name,
      environment === "atmosphere" ? "telescopic" : "articulated",
      layout === "dual" && environment === "vacuum"
    );
    const fixedLeft = position.fixedLeftOffsetPixels === void 0 ? "" : `;--fixed-left:calc(50% ${position.fixedLeftOffsetPixels < 0 ? "-" : "+"} ${Math.abs(position.fixedLeftOffsetPixels)}px)`;
    return `<div class="reference-robot-position" style="--robot-left:${position.leftPercent}%;--robot-top:${position.topPixels}px${fixedLeft}">${renderRobotHub(robot, snapshot.waferOrigins, environment, angleDegrees, mechanism)}</div>`;
  }).join("");
  const robotMarkup = renderRobotGroup(vacuumRobots, "vacuum") + renderRobotGroup(atmosphereRobots, "atmosphere");
  return `
    <section class="equipment-schematic" data-topology-layout="${layout}" aria-label="\u5B8C\u6574\u8BBE\u5907\u62D3\u6251\u56DE\u653E">
      <div class="schematic-canvas reference-grid-canvas" style="--topology-canvas-height:${canvasHeight}px">
        <div class="topology-status-legend" role="group" aria-label="\u56DE\u653E\u72B6\u6001\u56FE\u4F8B">
          <span><i class="topology-status-legend-processing"></i>\u52A0\u5DE5</span>
          <span><i class="topology-status-legend-pumping"></i>\u62BD\u6C14</span>
          <span><i class="topology-status-legend-venting"></i>\u5145\u6C14</span>
          <span><i class="topology-status-legend-cleaning"></i>\u6E05\u6D01</span>
          <span><i class="topology-status-legend-transfer"></i>\u4F20\u8F93</span>
          <span><i class="topology-status-legend-door"></i>\u95E8\u52A8\u4F5C</span>
        </div>
        ${machineAreaMarkup}
        ${machineFrameMarkup}
        ${atmosphereRobots.length ? `<div class="topology-atmosphere-rail" aria-label="\u5927\u6C14\u673A\u68B0\u624B\u8F68\u9053" style="top:${atmosphereFrame.centerTopPixels}px;width:${atmosphereFrame.widthPixels - TOPOLOGY_ATMOSPHERE_INTERIOR_INSET * 2}px"></div>` : ""}
        ${attachmentPointMarkup}
        ${moduleMarkup}
        ${robotMarkup}
      </div>
    </section>`;
}
function primitiveDecisionBoundaryTimes(moves) {
  return [...new Set(
    moves.filter((move) => PRIMITIVE_DECISION_COMPLETION_MOVE_TYPES.has(finiteNumber(move.MoveType, -1))).map((move) => finiteNumber(move.EndTime)).filter((time) => time >= 0)
  )].sort((left, right) => left - right);
}
function formatActionEndpoint(name, slot) {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return slot > 0 ? `${trimmed}#${slot}` : trimmed;
}
function formatActionPath(action) {
  const kindLabels = { pick: "Pick", place: "Place", swap: "Swap" };
  const materialIds2 = action.materialIds.filter(Boolean).join(",");
  const kindLabel = kindLabels[action.kind];
  const prefix = materialIds2 ? `${kindLabel}(${materialIds2})` : kindLabel;
  const source = formatActionEndpoint(action.source, action.sourceSlot);
  const destination = formatActionEndpoint(action.destination, action.destinationSlot);
  const path = [source, destination].filter(Boolean).join(" \u2192 ");
  return path ? `${prefix} ${path}` : prefix;
}
function renderDecisionLens(decision, requestState = "idle", requestError = "", statusFilters = ALL_ACTION_DIAGNOSTIC_STATUSES) {
  if (!decision) {
    if (requestState === "loading") {
      return `
        <div class="decision-empty is-loading" role="status" aria-live="polite">
          <div class="visual-loader" aria-hidden="true"></div>
          <strong>\u6B63\u5728\u66F4\u65B0\u5F53\u524D\u52A8\u4F5C</strong>
          <p>\u6B63\u5728\u6309 Move \u72B6\u6001\u8C03\u7528\u7B97\u6CD5\u52A8\u4F5C\u63A5\u53E3\u3002</p>
        </div>`;
    }
    if (requestState === "error") {
      return `
        <div class="decision-empty is-error" role="alert">
          <strong>\u52A8\u4F5C\u63A5\u53E3\u8C03\u7528\u5931\u8D25</strong>
          <p>${escapeHtml(requestError || "\u65E0\u6CD5\u83B7\u53D6\u5F53\u524D\u52A8\u4F5C\uFF0C\u8BF7\u68C0\u67E5\u670D\u52A1\u72B6\u6001\u3002")}</p>
        </div>`;
    }
    return `
      <div class="decision-empty">
        <strong>\u5F53\u524D\u52A8\u4F5C\u5361\u7247\u4E3A\u7A7A</strong>
        <p>\u5F53\u524D\u7B97\u6CD5\u672A\u63D0\u4F9B\u52A8\u4F5C\u63A5\u53E3\uFF0C\u6216\u56DE\u653E\u5230\u6B64\u65F6\u6CA1\u6709\u52A8\u4F5C\u3002</p>
      </div>`;
  }
  const statusLabels = {
    enabled: "\u4F7F\u80FD",
    "physical-blocked": "\u7269\u7406\u62E6\u622A",
    "deadlock-blocked": "\u6B7B\u9501\u89C4\u5219\u62E6\u622A"
  };
  const visibleActions = decision.actionDiagnostics.filter((action) => statusFilters.includes(action.status));
  const cards = visibleActions.map((action) => {
    const reason = action.reason || statusLabels[action.status];
    const duplicate = action.duplicateCount > 0 ? `<small>\u53E6 ${action.duplicateCount} \u7247\u76F8\u540C</small>` : "";
    return `
      <li class="decision-candidate action-card action-status-${action.status}" tabindex="0" aria-label="${escapeHtml(`${formatActionPath(action)}\uFF0C${statusLabels[action.status]}`)}">
        <strong class="action-card-path">${escapeHtml(formatActionPath(action))}</strong>
        ${duplicate}
        <span class="action-status-tooltip" role="tooltip">${escapeHtml(reason)}</span>
      </li>`;
  }).join("");
  const counts = decision.actionCounts;
  const provider = decision.actionDiagnosticsSource === "algorithm" ? `\u7B97\u6CD5\u63A5\u53E3 \xB7 ${decision.actionDiagnosticsProvider || "\u672A\u547D\u540D\u5B9E\u73B0"}` : "\u7B97\u6CD5\u672A\u63D0\u4F9B\u52A8\u4F5C\u63A5\u53E3";
  return `
    <section class="decision-candidate-section" aria-label="\u5F53\u524D\u5408\u6CD5\u52A8\u4F5C">
      <p class="action-count-summary">\u4F7F\u80FD ${counts.enabled} \xB7 \u7269\u7406\u62E6\u622A ${counts["physical-blocked"]} \xB7 \u6B7B\u9501\u62E6\u622A ${counts["deadlock-blocked"]}</p>
      ${cards ? `<ul>${cards}</ul>` : '<p class="decision-alternative-empty">\u5F53\u524D\u7B5B\u9009\u6761\u4EF6\u4E0B\u6CA1\u6709\u52A8\u4F5C</p>'}
    </section>`;
}
function formatPercent(value) {
  return `${(Math.max(0, value) * 100).toFixed(1)}%`;
}
function renderCategoryBars(resource, windowDuration) {
  return ACTIVITY_CATEGORIES.map((category) => {
    const duration = resource.categoryTimes[category];
    if (duration <= PERFORMANCE_DISPLAY_TOLERANCE || windowDuration <= PERFORMANCE_DISPLAY_TOLERANCE) return "";
    const width = Math.min(duration / windowDuration * 100, 100);
    return `<span class="category-${category}" style="width:${width.toFixed(3)}%" title="${ACTIVITY_CATEGORY_LABELS[category]} ${formatSeconds2(duration)} s"></span>`;
  }).join("");
}
function groupedBottleneckResources(performance2) {
  const resources = performance2.resources;
  const byName = new Map(resources.map((resource) => [resource.name, resource]));
  const assigned = /* @__PURE__ */ new Set();
  const memberGroups = [];
  const addGroup = (members) => {
    const uniqueMembers = members.filter((member) => !assigned.has(member.name));
    if (!uniqueMembers.length) return;
    uniqueMembers.forEach((member) => assigned.add(member.name));
    memberGroups.push(uniqueMembers);
  };
  for (const candidate of performance2.bottleneckCandidates) {
    if (candidate.kind !== "process-group") continue;
    addGroup(candidate.resourceNames.map((name) => byName.get(name)).filter((resource) => Boolean(resource)));
  }
  const remainingProcess = resources.filter((resource) => resource.kind === "process" && !assigned.has(resource.name));
  addGroup(remainingProcess);
  addGroup(resources.filter((resource) => resource.kind === "loadlock" && resource.busyTime > PERFORMANCE_DISPLAY_TOLERANCE));
  addGroup(resources.filter((resource) => resource.kind === "loadport" && resource.busyTime > PERFORMANCE_DISPLAY_TOLERANCE));
  for (const resource of resources.filter((resource2) => resource2.kind === "robot" || resource2.kind === "auxiliary")) addGroup([resource]);
  const sameMembers = (candidate, names) => candidate.resourceNames.length === names.length && candidate.resourceNames.every((name) => names.includes(name));
  return memberGroups.map((members) => {
    const memberNames = members.map((member) => member.name).sort((left, right) => left.localeCompare(right, void 0, { numeric: true, sensitivity: "base" }));
    const memberCount = members.length;
    const categoryTimes = Object.fromEntries(ACTIVITY_CATEGORIES.map((category) => [
      category,
      members.reduce((sum, member) => sum + member.categoryTimes[category], 0) / memberCount
    ]));
    return {
      name: memberNames.join(" / "),
      memberNames,
      kind: members[0].kind,
      utilization: members.reduce((sum, member) => sum + member.utilization, 0) / memberCount,
      busyTime: members.reduce((sum, member) => sum + member.busyTime, 0) / memberCount,
      categoryTimes,
      candidate: performance2.bottleneckCandidates.find((candidate) => sameMembers(candidate, memberNames)) ?? null
    };
  }).filter((group) => group.busyTime > PERFORMANCE_DISPLAY_TOLERANCE).sort((left, right) => right.utilization - left.utilization || left.name.localeCompare(right.name, void 0, { numeric: true, sensitivity: "base" })).slice(0, 4);
}
function renderBottleneckAnalysis(performance2) {
  const { window: window2 } = performance2;
  const confidenceLabels = { high: "\u8BC1\u636E\u8F83\u5F3A", medium: "\u8BC1\u636E\u4E2D\u7B49", low: "\u8BC1\u636E\u8F83\u5F31" };
  const resourceKindLabels = {
    robot: "\u673A\u68B0\u624B",
    process: "\u5DE5\u827A\u8154",
    loadlock: "LoadLock",
    loadport: "LoadPort",
    auxiliary: "\u8F85\u52A9\u6A21\u5757"
  };
  const displayedResources = groupedBottleneckResources(performance2).slice(0, 3);
  const resourceRows = (items) => items.map((resource, index) => {
    const candidate = resource.candidate;
    const evidenceScore = candidate ? Math.round(candidate.score * 100) : null;
    const evidenceLabel = candidate ? confidenceLabels[candidate.confidence] : "\u672A\u5165\u9009\u5019\u9009";
    const resourceLabel = resource.memberNames.length > 1 ? `${resourceKindLabels[resource.kind]} \xB7 ${resource.memberNames.length} \u53F0\u5E73\u5747` : resourceKindLabels[resource.kind];
    return `
      <li class="resource-utilization-row">
        <div class="resource-utilization-summary">
          <div class="resource-utilization-name">
            <span>${index + 1}</span>
            <div><strong>${escapeHtml(resource.name)}</strong><small>${escapeHtml(resourceLabel)}</small></div>
          </div>
          <strong class="resource-utilization-percent">${formatPercent(resource.utilization)}</strong>
          <div class="utilization-track" aria-label="${escapeHtml(resource.name)} \u5360\u7528\u7387 ${formatPercent(resource.utilization)}">${renderCategoryBars(resource, window2.duration)}</div>
          <div class="resource-evidence-score"><strong>${evidenceScore ?? "\u2014"}</strong><small>${evidenceLabel}</small></div>
          <span aria-hidden="true"></span>
        </div>
      </li>`;
  }).join("");
  const legend = ACTIVITY_CATEGORIES.map((category) => `<span><i class="performance-swatch category-${category}"></i>${ACTIVITY_CATEGORY_LABELS[category]}</span>`).join("");
  return `
    <header class="analysis-section-head bottleneck-analysis-head">
      <div class="analysis-section-title"><strong>\u74F6\u9888\u5206\u6790</strong></div>
      <div class="bottleneck-analysis-actions">
        <label class="bottleneck-window-control"><span class="visually-hidden">\u7EDF\u8BA1\u53E3\u5F84</span><div class="bottleneck-window-slot"></div></label>
        <button class="analysis-secondary-button bottleneck-analysis-help" id="bottleneckAnalysisHelpButton" type="button" aria-haspopup="dialog" aria-controls="bottleneckAnalysisHelpDialog"><span aria-hidden="true">\u24D8</span> \u8BF4\u660E</button>
      </div>
    </header>
    <ol class="resource-utilization-list">
      ${resourceRows(displayedResources)}
    </ol>
    <div class="performance-legend" aria-label="\u5360\u7528\u7EC4\u6210\u56FE\u4F8B">${legend}</div>
  `;
}
function renderResidenceMetricChart(samples, kind) {
  const definitions = {
    system: { title: "\u7CFB\u7EDF\u9A7B\u7559\u65F6\u95F4", label: "\u7CFB\u7EDF\u9A7B\u7559", value: (sample) => sample.duration },
    chamber: { title: "\u8154\u5BA4\u9A7B\u7559\u65F6\u95F4", label: "\u8154\u5BA4\u9A7B\u7559", value: (sample) => sample.chamberDwellSeconds ?? 0 },
    robot: { title: "\u673A\u5668\u624B\u9A7B\u7559\u65F6\u95F4", label: "\u673A\u5668\u624B\u9A7B\u7559", value: (sample) => sample.robotDwellSeconds ?? 0 }
  };
  const metric = definitions[kind];
  const values3 = samples.map(metric.value);
  const meanSeconds = values3.reduce((sum, value) => sum + value, 0) / values3.length;
  const maximumSeconds = Math.max(...values3, 1);
  const plotHeight = 150;
  const scaleMaximum = maximumSeconds * 1.08;
  const meanHeight = Math.min(meanSeconds / scaleMaximum * plotHeight, plotHeight);
  const bars = samples.map((sample) => {
    const seconds = metric.value(sample);
    const height = Math.max(seconds / scaleMaximum * plotHeight, 2);
    const wafer = escapeHtml(String(sample.wafer));
    const duration = formatSeconds2(seconds);
    return `
      <li class="residence-metric-bar-item" role="img" aria-label="\u6676\u5706 ${wafer}\uFF0C${metric.label} ${duration} \u79D2">
        <strong>${duration}</strong>
        <span class="residence-metric-bar residence-bar-${kind}"><i style="height:${height.toFixed(2)}px"></i></span>
        <small>${wafer}</small>
      </li>`;
  }).join("");
  return `
    <div class="residence-metric-chart residence-metric-${kind}" data-residence-metric-chart="${kind}"${kind === "system" ? "" : " hidden"}>
      <div class="residence-metric-scroll" tabindex="0" aria-label="\u9010\u7247\u6676\u5706${metric.title}\u67F1\u72B6\u56FE\uFF0C\u53EF\u6A2A\u5411\u6EDA\u52A8">
        <div class="residence-metric-plot">
          <div class="residence-metric-mean-line" style="bottom:${(26 + meanHeight).toFixed(2)}px"><span>\u5E73\u5747 ${formatSeconds2(meanSeconds)} s</span></div>
          <ol class="residence-metric-bars">${bars}</ol>
        </div>
      </div>
    </div>`;
}
function renderWaferResidenceChart(performance2) {
  const samples = performance2.waferSystemResidenceTimes ?? [];
  const helpButton = `<button class="analysis-secondary-button residence-analysis-help" id="residenceAnalysisHelpButton" type="button" aria-haspopup="dialog" aria-controls="residenceAnalysisHelpDialog"><span aria-hidden="true">\u24D8</span> \u8BF4\u660E</button>`;
  if (!samples.length) {
    return `
      <header class="analysis-section-head residence-chart-head"><div class="analysis-section-title"><strong>\u9A7B\u7559\u65F6\u95F4\u5206\u6790</strong></div>${helpButton}</header>
      <div class="analysis-empty-state"><strong>\u6682\u65E0\u9A7B\u7559\u6570\u636E</strong><span>\u5F53\u524D\u7ED3\u679C\u4E2D\u6CA1\u6709\u5B8C\u6210\u5F80\u8FD4 LoadPort \u7684\u6676\u5706\u3002</span></div>`;
  }
  const systemValues = samples.map((sample) => sample.duration);
  const chamberValues = samples.map((sample) => sample.chamberDwellSeconds ?? 0);
  const robotValues = samples.map((sample) => sample.robotDwellSeconds ?? 0);
  const metricSummary = (values3, label) => {
    const mean = values3.reduce((sum, value) => sum + value, 0) / values3.length;
    const deviation = Math.sqrt(values3.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values3.length);
    const upperControlLimit = mean + deviation * 2;
    const abnormalCount = values3.filter((value) => value > upperControlLimit).length;
    return `<span><small>\u5E73\u5747</small><b>${formatSeconds2(mean)}</b><em>s</em></span><span><small>\u6700\u5927</small><b>${formatSeconds2(Math.max(...values3))}</b><em>s</em></span><span class="${abnormalCount ? "is-warning" : ""}"><small>\u504F\u9AD8\u6BD4\u4F8B</small><b>${(abnormalCount / values3.length * 100).toFixed(1)}</b><em>%</em></span><span><small>\u6837\u672C</small><b>${values3.length}</b><em>\u7247</em></span><span class="visually-hidden">${label}</span>`;
  };
  const summary = (kind, content) => `<div class="analysis-compact-stats residence-chart-summary" data-residence-summary="${kind}"${kind === "system" ? "" : " hidden"}>${content}</div>`;
  return `
    <header class="analysis-section-head residence-chart-head">
      <div class="analysis-section-title"><strong>\u9A7B\u7559\u65F6\u95F4\u5206\u6790</strong></div>
      <label class="analysis-filter residence-metric-control"><select id="residenceMetricSelect" aria-label="\u9009\u62E9\u9A7B\u7559\u65F6\u95F4\u56FE\u8868">
        <option value="system">\u7CFB\u7EDF\u9A7B\u7559\u65F6\u95F4</option>
        <option value="chamber">\u8154\u5BA4\u9A7B\u7559\u65F6\u95F4</option>
        <option value="robot">\u673A\u5668\u624B\u9A7B\u7559\u65F6\u95F4</option>
      </select></label>
      ${summary("system", metricSummary(systemValues, "\u7CFB\u7EDF\u9A7B\u7559"))}
      ${summary("chamber", metricSummary(chamberValues, "\u8154\u5BA4\u9A7B\u7559"))}
      ${summary("robot", metricSummary(robotValues, "\u673A\u5668\u624B\u9A7B\u7559"))}
      ${helpButton}
    </header>
    <div class="residence-chart-body">
      ${renderResidenceMetricChart(samples, "system")}
      ${renderResidenceMetricChart(samples, "chamber")}
      ${renderResidenceMetricChart(samples, "robot")}
    </div>`;
}
function filterThroughputPoints(points, range) {
  if (!points.length || range === "all") return points;
  const [kind, rawAmount] = range.split(":");
  const amount = Number(rawAmount);
  if (!Number.isFinite(amount) || amount <= 0) return points;
  if (kind === "wafer") return points.slice(-Math.floor(amount));
  if (kind === "time") {
    const cutoff = points[points.length - 1].completedAt - amount;
    const filtered = points.filter((point) => point.completedAt >= cutoff);
    return filtered.length ? filtered : points.slice(-1);
  }
  return points;
}
var MAXIMUM_THROUGHPUT_DRAW_POINTS = 72;
var MAXIMUM_THROUGHPUT_VALUE_LABELS = 12;
function simplifyThroughputPoints(points) {
  if (points.length <= MAXIMUM_THROUGHPUT_DRAW_POINTS) return points;
  const interior = points.slice(1, -1);
  const bucketCount = Math.max(1, Math.floor((MAXIMUM_THROUGHPUT_DRAW_POINTS - 2) / 2));
  const selected = [points[0]];
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = Math.floor(bucket * interior.length / bucketCount);
    const end = Math.max(start + 1, Math.floor((bucket + 1) * interior.length / bucketCount));
    const rows = interior.slice(start, end).map((point, index) => ({ point, index: start + index }));
    const minimum = rows.reduce((best, row) => row.point.throughputPerHour < best.point.throughputPerHour ? row : best);
    const maximum = rows.reduce((best, row) => row.point.throughputPerHour > best.point.throughputPerHour ? row : best);
    [minimum, maximum].sort((left, right) => left.index - right.index).forEach((row) => {
      if (selected[selected.length - 1] !== row.point) selected.push(row.point);
    });
  }
  selected.push(points[points.length - 1]);
  return selected;
}
function renderThroughputSvg(points, title) {
  const width = 760;
  const height = 174;
  const left = 12;
  const right = 12;
  const top = 12;
  const bottom = 12;
  const usableWidth = width - left - right;
  const usableHeight = height - top - bottom;
  const allValues = points.map((point) => Math.max(0, Number(point.throughputPerHour) || 0));
  const mean = allValues.reduce((sum, value) => sum + value, 0) / allValues.length;
  const displayPoints = simplifyThroughputPoints(points);
  const values3 = displayPoints.map((point) => Math.max(0, Number(point.throughputPerHour) || 0));
  const observedMinimum = Math.min(...values3);
  const observedMaximum = Math.max(...values3);
  const spread = Math.max(observedMaximum - observedMinimum, Math.max(mean * 0.04, 1));
  const padding = Math.max(1, spread * 0.18);
  const step = spread > 20 ? 5 : spread > 8 ? 2 : 1;
  const minimum = Math.max(0, Math.floor((observedMinimum - padding) / step) * step);
  const maximum = Math.max(minimum + step * 3, Math.ceil((observedMaximum + padding) / step) * step);
  const yRange = maximum - minimum;
  const firstIndex = displayPoints[0].completedWaferIndex;
  const lastIndex = displayPoints[displayPoints.length - 1].completedWaferIndex;
  const indexRange = Math.max(1, lastIndex - firstIndex);
  const coordinates = displayPoints.map((point, index) => ({
    x: left + (point.completedWaferIndex - firstIndex) / indexRange * usableWidth,
    y: top + (1 - (values3[index] - minimum) / yRange) * usableHeight
  }));
  const linePath = coordinates.length === 1 ? `M ${coordinates[0].x.toFixed(2)} ${coordinates[0].y.toFixed(2)}` : coordinates.reduce((path, point, index) => {
    if (index === 0) return `M ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
    return `${path} L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
  }, "");
  const latest = displayPoints[displayPoints.length - 1];
  const yForValue = (value) => top + (1 - (value - minimum) / yRange) * usableHeight;
  const meanY = yForValue(mean);
  const labelStride = Math.max(1, Math.ceil(displayPoints.length / MAXIMUM_THROUGHPUT_VALUE_LABELS));
  const pointTargets = displayPoints.map((point, index) => {
    const coordinate = coordinates[index];
    const value = values3[index];
    const previousValue = values3[index - 1] ?? value;
    const nextValue = values3[index + 1] ?? value;
    const isLocalMinimum = index > 0 && index < values3.length - 1 && value <= previousValue && value <= nextValue;
    const labelY = isLocalMinimum ? Math.min(top + usableHeight - 4, coordinate.y + 17) : Math.max(top + 10, coordinate.y - 9);
    const labelClass = isLocalMinimum ? "throughput-chart-value is-below" : "throughput-chart-value";
    const showLabel = index === 0 || index === displayPoints.length - 1 || index % labelStride === 0;
    return `${showLabel ? `<text class="${labelClass}" x="${coordinate.x.toFixed(2)}" y="${labelY.toFixed(2)}" text-anchor="middle">${value.toFixed(1)}</text>` : ""}<circle class="throughput-chart-point" cx="${coordinate.x.toFixed(2)}" cy="${coordinate.y.toFixed(2)}" r="${displayPoints.length > 36 ? "1.8" : "2.6"}"/>`;
  }).join("");
  return `
        <svg class="throughput-chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${title}\uFF0C\u6700\u65B0\u4E3A\u7B2C ${latest.completedWaferIndex} \u7247\uFF0C\u6BCF\u5C0F\u65F6 ${latest.throughputPerHour.toFixed(1)} \u7247">
          <g class="throughput-control-lines">
            <line class="throughput-mean-line" x1="${left}" y1="${meanY.toFixed(2)}" x2="${width - right}" y2="${meanY.toFixed(2)}"/>
          </g>
          <path class="throughput-chart-line" d="${linePath}"/>
          ${pointTargets}
          <circle class="throughput-chart-latest" cx="${coordinates[coordinates.length - 1].x.toFixed(2)}" cy="${coordinates[coordinates.length - 1].y.toFixed(2)}" r="4"/>
        </svg>`;
}
function renderThroughputLine(points, chartKey, title, visible, initialRange = "wafer:30") {
  const serializedPoints = escapeHtml(JSON.stringify(points));
  const visiblePoints = filterThroughputPoints(points, initialRange);
  return `
    <div class="throughput-chart" data-throughput-chart="${chartKey}" data-throughput-title="${escapeHtml(title)}" data-throughput-points="${serializedPoints}"${visible ? "" : " hidden"}>
      <div class="throughput-chart-scroll" tabindex="0" aria-label="${escapeHtml(title)}\uFF0C\u9010\u70B9\u5C55\u793A\u4EA7\u80FD\u6570\u503C">
        <div class="throughput-chart-canvas">${renderThroughputSvg(visiblePoints, title)}</div>
      </div>
    </div>`;
}
function updateThroughputChartRange(chart, range) {
  const rawPoints = chart.dataset.throughputPoints;
  const chartKey = chart.dataset.throughputChart ?? "throughput";
  const title = chart.dataset.throughputTitle ?? "\u4EA7\u80FD\u66F2\u7EBF";
  if (!rawPoints) return;
  const points = filterThroughputPoints(JSON.parse(rawPoints), range);
  const canvas = chart.querySelector(".throughput-chart-canvas");
  if (!canvas || !points.length) return;
  canvas.innerHTML = renderThroughputSvg(points, title);
}
function renderThroughputChart(performance2) {
  const timeline = performance2.throughputTimeline;
  const helpButton = `<button class="analysis-secondary-button throughput-analysis-help" id="throughputAnalysisHelpButton" type="button" aria-haspopup="dialog" aria-controls="throughputAnalysisHelpDialog"><span aria-hidden="true">\u24D8</span> \u8BF4\u660E</button>`;
  if (!timeline?.cumulative?.length) {
    return `
      <header class="analysis-section-head throughput-chart-head"><div class="analysis-section-title"><strong>\u4EA7\u80FD\u5206\u6790</strong></div>${helpButton}</header>
      <div class="analysis-empty-state"><strong>\u6682\u65E0\u751F\u4EA7\u6570\u636E</strong><span>\u8BF7\u7B49\u5F85\u65B0\u7684\u6676\u5706\u5B8C\u6210\u540E\u67E5\u770B\u5206\u6790\u7ED3\u679C\u3002</span></div>`;
  }
  const cumulative = timeline.cumulative;
  const minimumWindow = timeline.rollingWindowMinimum;
  const maximumWindow = timeline.rollingWindowMaximum;
  const defaultWindow = Math.min(Math.max(5, minimumWindow), maximumWindow);
  const windowOptions = Array.from(
    { length: maximumWindow - minimumWindow + 1 },
    (_, index) => minimumWindow + index
  );
  const lastCumulative = cumulative[cumulative.length - 1];
  const summary = (chartKey, content, visible) => `<div class="analysis-compact-stats throughput-chart-summary" data-throughput-summary="${chartKey}"${visible ? "" : " hidden"}>${content}</div>`;
  const rollingContent = windowOptions.map((windowSize) => {
    const points = timeline.rollingByWindow[String(windowSize)] ?? [];
    const latest = points[points.length - 1];
    const average = points.length ? points.reduce((sum, point) => sum + point.throughputPerHour, 0) / points.length : 0;
    return summary(
      `rolling-${windowSize}`,
      latest ? `<span><small>\u6700\u65B0</small><b>${latest.throughputPerHour.toFixed(1)}</b><em>\u7247/h</em></span><span><small>\u5E73\u5747</small><b>${average.toFixed(1)}</b><em>\u7247/h</em></span>` : `<span class="is-muted"><small>\u6837\u672C\u72B6\u6001</small><b>\u4E0D\u8DB3</b><em>\u81F3\u5C11 ${windowSize + 1} \u7247</em></span>`,
      windowSize === defaultWindow
    );
  }).join("");
  const rollingCharts = windowOptions.map((windowSize) => {
    const points = timeline.rollingByWindow[String(windowSize)] ?? [];
    const chartKey = `rolling-${windowSize}`;
    return points.length ? renderThroughputLine(points, chartKey, `${windowSize} \u7247\u6ED1\u52A8\u7A97\u53E3\u4EA7\u80FD\u66F2\u7EBF`, windowSize === defaultWindow) : `<div class="throughput-chart-empty" data-throughput-chart="${chartKey}" hidden>\u5C1A\u672A\u5F62\u6210\u5B8C\u6574 ${windowSize} \u7247\u6ED1\u52A8\u7A97\u53E3\u3002</div>`;
  }).join("");
  const cumulativeAverage = cumulative.reduce((sum, point) => sum + point.throughputPerHour, 0) / cumulative.length;
  return `
    <header class="analysis-section-head throughput-chart-head">
      <div class="analysis-section-title"><strong>\u4EA7\u80FD\u5206\u6790</strong></div>
      <div class="analysis-filter-group">
      <label class="analysis-filter throughput-metric-control"><select id="throughputMetricSelect" aria-label="\u9009\u62E9\u4EA7\u80FD\u53E3\u5F84">
        <option value="cumulative">\u7D2F\u8BA1\u4EA7\u80FD\uFF08\u516C\u53F8\u53E3\u5F84\uFF09</option>
        <option value="rolling" selected>\u6ED1\u52A8\u7A97\u53E3</option>
      </select></label>
      <label class="analysis-filter throughput-window-control" data-throughput-window-control><select id="throughputWindowSize" aria-label="\u6ED1\u52A8\u7A97\u53E3\u5927\u5C0F">${windowOptions.map((windowSize) => `<option value="${windowSize}"${windowSize === defaultWindow ? " selected" : ""}>${windowSize} \u7247</option>`).join("")}</select></label>
      <label class="analysis-filter throughput-range-control"><select id="throughputRangeSelect" aria-label="\u9009\u62E9\u4EA7\u80FD\u56FE\u663E\u793A\u8303\u56F4"><option value="wafer:30" selected>\u6700\u8FD1 30 \u7247</option><option value="wafer:60">\u6700\u8FD1 60 \u7247</option><option value="wafer:120">\u6700\u8FD1 120 \u7247</option><option value="time:600">\u6700\u8FD1 10 \u5206\u949F</option><option value="time:1800">\u6700\u8FD1 30 \u5206\u949F</option><option value="all">\u5168\u90E8</option></select></label>
      </div>
      ${summary("cumulative", `<span><small>\u6700\u65B0</small><b>${lastCumulative.throughputPerHour.toFixed(1)}</b><em>\u7247/h</em></span><span><small>\u5E73\u5747</small><b>${cumulativeAverage.toFixed(1)}</b><em>\u7247/h</em></span><span><small>\u65F6\u523B</small><b>${formatSeconds2(lastCumulative.completedAt)}</b><em>s</em></span>`, false)}
      ${rollingContent}
      ${helpButton}
    </header>
    <div class="throughput-chart-body">
      <div class="analysis-chart-legend" aria-label="\u4EA7\u80FD\u56FE\u56FE\u4F8B"><span><i class="legend-current"></i>\u5F53\u524D\u4EA7\u80FD</span><span><i class="legend-average"></i>\u663E\u793A\u8303\u56F4\u5E73\u5747</span></div>
      ${renderThroughputLine(cumulative, "cumulative", "\u7D2F\u8BA1\u4EA7\u80FD\u66F2\u7EBF", false)}
      ${rollingCharts}
    </div>`;
}
function renderSchedulePerformance(performance2) {
  const loadLockEfficiency = performance2.loadLockEfficiency ?? {
    cycleCount: 0,
    waferCycleCount: 0,
    wafersPerCycle: 0,
    fullLoadCycleCount: 0,
    emptyLoadCycleCount: 0,
    fullLoadCycleRatio: 0,
    emptyLoadCycleRatio: 0
  };
  const kpiCard = (label, value, unit, detail, cardClass = "") => `
    <article class="performance-kpi-card ${cardClass}">
      <div class="performance-kpi-label">
        <span>${label}</span>
        <span class="performance-kpi-help" tabindex="0" aria-label="${escapeHtml(detail)}">
          <i aria-hidden="true">i</i><span class="performance-kpi-tooltip" role="tooltip">${detail}</span>
        </span>
      </div>
      <div class="performance-kpi-value"><strong>${value}</strong>${unit ? `<small>${unit}</small>` : ""}</div>
    </article>`;
  const primaryBottleneck = performance2.primaryBottleneck;
  const bottleneckUtilization = primaryBottleneck?.utilization ?? performance2.bottleneck?.utilization ?? null;
  const bottleneckDetail = bottleneckUtilization !== null ? "\u5F53\u524D\u7EDF\u8BA1\u7A97\u53E3\u5185\u6700\u9AD8\u7684\u8D44\u6E90\u5229\u7528\u7387" : "\u5F53\u524D\u7EDF\u8BA1\u7A97\u53E3\u5185\u672A\u5F62\u6210\u660E\u786E\u74F6\u9888";
  return `
    <section class="result-card overview-card">
      <div class="performance-summary">
        ${kpiCard("\u4EA7\u80FD", performance2.throughputPerHour > 0 ? performance2.throughputPerHour.toFixed(1) : "\u2014", performance2.throughputPerHour > 0 ? "\u7247/h" : "", performance2.throughputSampleCount ? `\u5C45\u4E2D ${performance2.throughputSampleCount} \u7247\u7A33\u6001\u6837\u672C` : escapeHtml(performance2.throughputReason || "\u6837\u672C\u4E0D\u8DB3\uFF0C\u5B8C\u5DE5\u7247\u6570\u5FC5\u987B\u5927\u4E8E 150"), "is-primary")}
        ${kpiCard("\u5E73\u5747\u91CD\u7B97\u65F6\u95F4", Number.isFinite(performance2.averageRecomputeTimeMs) ? Number(performance2.averageRecomputeTimeMs).toFixed(1) : "\u2014", Number.isFinite(performance2.averageRecomputeTimeMs) ? "ms" : "", performance2.recomputeCount ? `CPU Time / ${performance2.recomputeCount} \u6B21\u91CD\u7B97` : "\u6CA1\u6709\u91CD\u7B97\u8F6E\u6B21")}
        ${kpiCard("\u74F6\u9888\u5229\u7528\u7387", bottleneckUtilization !== null ? formatPercent(bottleneckUtilization) : "\u2014", "", bottleneckDetail)}
        ${kpiCard("LoadLock \u5229\u7528\u6548\u7387", loadLockEfficiency.cycleCount ? loadLockEfficiency.wafersPerCycle.toFixed(2) : "\u2014", loadLockEfficiency.cycleCount ? "\u7247/\u5468\u671F" : "", loadLockEfficiency.cycleCount ? `${loadLockEfficiency.cycleCount} \u4E2A\u5B8C\u6574\u5468\u671F \xB7 \u6EE1\u8F7D ${formatPercent(loadLockEfficiency.fullLoadCycleRatio)} \xB7 \u7A7A\u8F7D ${formatPercent(loadLockEfficiency.emptyLoadCycleRatio)}` : "\u6CA1\u6709\u5B8C\u6574\u7684\u62BD\u6C14\u2014\u5145\u6C14\u5468\u671F")}
      </div>
    </section>

    <section class="result-card throughput-analysis-card">
      ${renderThroughputChart(performance2)}
    </section>

    <section class="result-card bottleneck-analysis-card">
      ${renderBottleneckAnalysis(performance2)}
    </section>

    <section class="result-card wafer-residence-card">
      ${renderWaferResidenceChart(performance2)}
    </section>

    `;
}
var VisualizationWorkspace = class {
  root;
  elements;
  device = null;
  analysisRoutes = [];
  analysisRounds = [];
  moves = [];
  loadPortReplenishments = [];
  replayPlan = null;
  actionStatusFilters = [...ALL_ACTION_DIAGNOSTIC_STATUSES];
  liveDecision = null;
  liveDecisionKey = "";
  primitiveDecisionBoundaries = [];
  replayDecisionCache = /* @__PURE__ */ new Map();
  pendingReplayDecisionKeys = /* @__PURE__ */ new Set();
  replayDecisionErrorKey = "";
  replayDecisionErrorMessage = "";
  replayDecisionRequestVersion = 0;
  sourceName = "";
  resultUrl = "";
  analysisResultId = "";
  analysis = null;
  cpuTimeMs = null;
  recomputeCount = 0;
  bottleneckSummary = null;
  analysisRequestVersion = 0;
  time = 0;
  playing = false;
  liveSolving = false;
  playbackSpeed = DEFAULT_PLAYBACK_SPEED;
  performanceWindowMode = "steady";
  animationFrame = 0;
  previousFrameTime = 0;
  previousRenderTime = 0;
  /** 绑定页面事件并初始化空状态。 */
  constructor(root) {
    this.root = root;
    this.elements = collectElements(root);
    const selectedFilters = this.elements.actionStatusFilters.filter((item) => item.checked).map((item) => item.value);
    if (selectedFilters.length) this.actionStatusFilters = selectedFilters;
    this.bindEvents();
    this.updatePlayButton();
    this.setTopologyVisible(false);
  }
  /** 更新当前设备拓扑；已有 MoveList 会立即按新拓扑重绘。 */
  setDevice(device) {
    this.device = device ? structuredClone(device) : null;
    if (this.moves.length) {
      this.render();
      void this.renderPerformance();
    }
  }
  /** 加载浏览器中选择的 MoveList 文件。 */
  async loadFile(file) {
    const payload = JSON.parse(await file.text());
    const metadata = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.RunMetricsMetadata ?? payload.ProductionMetricsMetadata : null;
    const rawCpuTimeMs = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? Number(metadata.cpuTimeMs ?? Number(metadata.calculationSeconds) * 1e3) : Number.NaN;
    const recomputePoints = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.RecomputePoints : null;
    const metadataRecomputeCount = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? Number(metadata.recomputeCount) : Number.NaN;
    const rawRecomputeCount = Number.isFinite(metadataRecomputeCount) ? metadataRecomputeCount : Array.isArray(recomputePoints) && Number.isFinite(rawCpuTimeMs) ? recomputePoints.length + 1 : 0;
    await this.loadMoves(
      normalizeMovePayload(payload),
      normalizeDecisionTrace(payload),
      normalizeLoadPortReplenishments(payload),
      file.name,
      "",
      "",
      Number.isFinite(rawCpuTimeMs) ? Math.max(rawCpuTimeMs, 0) : null,
      Number.isFinite(rawRecomputeCount) ? Math.max(0, Math.trunc(rawRecomputeCount)) : 0
    );
  }
  /** 从后端保存的运行结果加载 MoveList。 */
  async loadResult(resultIdOrUrl, sourceName = "\u5F53\u524D\u8FD0\u884C\u7ED3\u679C") {
    const resultUrl = resultIdOrUrl.startsWith("/") ? resultIdOrUrl : `/api/results/${encodeURIComponent(resultIdOrUrl)}`;
    this.setLoading(true, "\u6B63\u5728\u52A0\u8F7D\u8FD0\u884C\u7ED3\u679C\u2026");
    try {
      const response = await fetch(resultUrl, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        const message = payload && typeof payload === "object" ? String(payload.error ?? "") : "";
        throw new Error(message || `\u670D\u52A1\u8FD4\u56DE ${response.status}`);
      }
      const resultId = resultUrl.startsWith("/api/results/") ? decodeURIComponent(resultUrl.slice("/api/results/".length)) : "";
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const replayContext = payload.ReplayContext;
        if (replayContext && typeof replayContext === "object" && !Array.isArray(replayContext)) {
          const embeddedPlan = replayContext.plan;
          if (embeddedPlan && typeof embeddedPlan === "object" && !Array.isArray(embeddedPlan)) {
            this.setReplayPlan(embeddedPlan);
          }
        }
      }
      await this.loadMoves(
        normalizeMovePayload(payload),
        normalizeDecisionTrace(payload),
        normalizeLoadPortReplenishments(payload),
        sourceName,
        resultUrl,
        resultId,
        null,
        0
      );
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  /** 提供后端构建工序容量上下文所需的原始 Route 和轮次配置。 */
  setAnalysisConfiguration(routes, rounds) {
    this.analysisRoutes = structuredClone(routes ?? []);
    this.analysisRounds = structuredClone(rounds ?? []);
    if (this.moves.length) void this.renderPerformance();
  }
  /** 保存 Machine 回放所需的完整计划；任意来源 MoveList 都使用该计划实时评分。 */
  setReplayPlan(plan) {
    this.replayPlan = plan ? structuredClone(plan) : null;
    this.replayDecisionCache.clear();
    this.pendingReplayDecisionKeys.clear();
    this.replayDecisionErrorKey = "";
    this.replayDecisionErrorMessage = "";
    this.liveDecision = null;
    this.liveDecisionKey = "";
    this.primitiveDecisionBoundaries = primitiveDecisionBoundaryTimes(this.moves);
    this.replayDecisionRequestVersion += 1;
    if (this.elements.exportDiagnosticButton) {
      this.elements.exportDiagnosticButton.disabled = !this.replayPlan || !this.moves.length;
    }
    if (this.moves.length) this.render();
  }
  /** 在完整 MoveList 返回前显示初始拓扑，并进入增量求解状态。 */
  beginLiveSolve(plan, sourceName = "Search Tree \u5B9E\u65F6\u6C42\u89E3") {
    this.pause();
    this.liveSolving = true;
    this.moves = [];
    this.loadPortReplenishments = [];
    this.loadPortReplenishments = [];
    this.sourceName = sourceName;
    this.resultUrl = "";
    this.analysisResultId = "";
    this.analysis = null;
    this.cpuTimeMs = null;
    this.recomputeCount = 0;
    this.bottleneckSummary = null;
    this.time = 0;
    this.setReplayPlan(plan);
    this.elements.range.min = "0";
    this.elements.range.max = "0";
    this.elements.range.value = "0";
    this.elements.range.disabled = true;
    this.elements.playButton.disabled = true;
    this.elements.openGantt.href = "#";
    this.elements.openGantt.setAttribute("aria-disabled", "true");
    if (this.elements.exportDiagnosticButton) this.elements.exportDiagnosticButton.disabled = true;
    this.showSingleResult();
    this.setTopologyVisible(true);
    this.render(buildWorkspaceSnapshot([], this.device, 0));
  }
  /** 用已提交根动作产生的累计 MoveList 推进实时拓扑。 */
  updateLiveMoves(rawMoves, followLatest = true, animateToLatest = false) {
    if (!this.liveSolving || !rawMoves.length) return;
    const previousTime = this.time;
    this.pause();
    this.moves = normalizeMovePayload({ MoveList: rawMoves });
    if (this.elements.exportDiagnosticButton) {
      this.elements.exportDiagnosticButton.disabled = !this.replayPlan;
    }
    this.primitiveDecisionBoundaries = primitiveDecisionBoundaryTimes(this.moves);
    const latestSnapshot = buildWorkspaceSnapshot(
      this.moves,
      this.device,
      Number.POSITIVE_INFINITY
    );
    this.elements.range.max = String(latestSnapshot.endTime);
    this.elements.range.step = latestSnapshot.endTime > 1e4 ? "1" : "0.1";
    if (animateToLatest && followLatest && latestSnapshot.endTime > previousTime + PERFORMANCE_DISPLAY_TOLERANCE) {
      this.time = Math.max(0, Math.min(previousTime, latestSnapshot.endTime));
      this.elements.range.value = String(this.time);
      this.render(buildWorkspaceSnapshot(this.moves, this.device, this.time));
      this.play();
      return;
    }
    this.time = followLatest ? latestSnapshot.endTime : Math.min(this.time, latestSnapshot.endTime);
    this.render(buildWorkspaceSnapshot(this.moves, this.device, this.time));
  }
  /** 把拓扑回放定位到某个根决策已经提交后的时刻。 */
  seekTo(time) {
    if (!this.moves.length) return;
    const bounded = Math.max(
      0,
      Math.min(finiteNumber(time), finiteNumber(this.elements.range.max))
    );
    this.time = bounded;
    this.elements.range.value = String(bounded);
    this.render();
  }
  /** 切换到独立拓扑回放标签。 */
  showPlayback() {
    const tab = this.root.querySelector('[data-tab-target="playback"]');
    tab?.click();
  }
  /** 返回与诊断面板一致的稳态瓶颈候选利用率，供运行结果摘要复用。 */
  getBottleneckUtilization() {
    return this.bottleneckSummary ? structuredClone(this.bottleneckSummary) : null;
  }
  /** 返回当前 MoveList 在前端回放终点识别出的持片满腔死锁。 */
  getTerminalDeadlock() {
    return detectTerminalPlaybackDeadlock(this.moves, this.device, this.replayPlan);
  }
  /** 切换到工作台标签。 */
  show() {
    if (this.moves.length) this.showSingleResult();
    const tab = this.root.querySelector('[data-tab-target="workspace"]');
    tab?.click();
    this.elements.performanceWindow.focus({ preventScroll: true });
  }
  /** 显示测试组统计，并隐藏当前单例诊断；独立回放页保留已加载的数据。 */
  showGroupAnalysis(markup) {
    this.pause();
    this.elements.empty.hidden = true;
    this.elements.content.hidden = true;
    this.elements.groupAnalysis.innerHTML = markup;
    this.elements.groupAnalysis.hidden = false;
  }
  /** 停止播放并释放动画帧。 */
  destroy() {
    this.pause();
  }
  /** 清除旧测试结果，避免切换测试后继续误看上一份 MoveList。 */
  clear() {
    this.pause();
    this.liveSolving = false;
    this.moves = [];
    this.liveDecision = null;
    this.liveDecisionKey = "";
    this.primitiveDecisionBoundaries = [];
    this.replayDecisionCache.clear();
    this.pendingReplayDecisionKeys.clear();
    this.replayDecisionErrorKey = "";
    this.replayDecisionErrorMessage = "";
    this.replayDecisionRequestVersion += 1;
    this.sourceName = "";
    this.resultUrl = "";
    this.analysisResultId = "";
    this.analysis = null;
    this.cpuTimeMs = null;
    this.recomputeCount = 0;
    this.bottleneckSummary = null;
    this.analysisRequestVersion += 1;
    this.time = 0;
    this.elements.resultButton.disabled = true;
    this.elements.range.disabled = false;
    this.elements.playButton.disabled = false;
    this.elements.openGantt.href = "#";
    this.elements.openGantt.setAttribute("aria-disabled", "true");
    this.elements.toolbar.hidden = false;
    this.elements.groupAnalysis.hidden = true;
    this.elements.groupAnalysis.innerHTML = "";
    this.elements.content.hidden = true;
    this.elements.empty.hidden = false;
    this.elements.playbackEmpty.hidden = false;
    this.setTopologyVisible(false);
    this.elements.empty.classList.remove("is-loading", "is-error");
    this.elements.empty.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="3"/><path d="M8 9h8M8 13h5"/></svg>
      <strong>\u7B49\u5F85\u5206\u6790\u6570\u636E</strong>
      <span>\u8FD0\u884C\u4E00\u6B21\u8BA1\u5212\uFF0C\u6216\u5728\u62D3\u6251\u56DE\u653E\u754C\u9762\u5BFC\u5165\u5DF2\u6709\u7684 MoveList JSON \u6587\u4EF6\u540E\u67E5\u770B\u7ED3\u679C\u5206\u6790\u3002</span>`;
    this.elements.playbackEmpty.classList.remove("is-loading", "is-error");
    this.elements.playbackEmpty.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><path d="m7 7.3 2.8 2.8M17 7.3l-2.8 2.8M7 16.7l2.8-2.8M17 16.7l-2.8-2.8"/></svg>
      <strong>\u7B49\u5F85 MoveList</strong>
      <span>\u8FD0\u884C\u4E00\u6B21\u8BA1\u5212\uFF0C\u6216\u5BFC\u5165\u5DF2\u6709\u7684 MoveList JSON \u6587\u4EF6\u540E\u67E5\u770B\u8BBE\u5907\u62D3\u6251\u5E76\u5F00\u59CB\u56DE\u653E\u3002</span>`;
  }
  /** 接收规范化后的 MoveList 并重置时间轴。 */
  async loadMoves(moves, _decisionTrace, loadPortReplenishments, sourceName, resultUrl, analysisResultId, cpuTimeMs = null, recomputeCount = 0) {
    if (!moves.length) throw new Error("MoveList \u4E3A\u7A7A\uFF0C\u65E0\u6CD5\u5EFA\u7ACB\u53EF\u89C6\u5316\u56DE\u653E");
    this.pause();
    this.liveSolving = false;
    this.moves = moves;
    this.loadPortReplenishments = loadPortReplenishments;
    this.primitiveDecisionBoundaries = primitiveDecisionBoundaryTimes(moves);
    this.liveDecision = null;
    this.liveDecisionKey = "";
    this.replayDecisionCache.clear();
    this.pendingReplayDecisionKeys.clear();
    this.replayDecisionErrorKey = "";
    this.replayDecisionErrorMessage = "";
    this.replayDecisionRequestVersion += 1;
    this.sourceName = sourceName;
    this.resultUrl = resultUrl;
    this.analysisResultId = analysisResultId;
    this.analysis = null;
    this.cpuTimeMs = cpuTimeMs;
    this.recomputeCount = recomputeCount;
    this.bottleneckSummary = null;
    const snapshot = buildWorkspaceSnapshot(this.moves, this.device, 0, this.loadPortReplenishments);
    this.time = 0;
    this.elements.range.min = "0";
    this.elements.range.max = String(snapshot.endTime);
    this.elements.range.step = snapshot.endTime > 1e4 ? "1" : "0.1";
    this.elements.range.value = "0";
    this.elements.range.disabled = false;
    this.elements.playButton.disabled = false;
    this.elements.openGantt.href = resultUrl ? `/movelist_gantt_viewer.html?src=${encodeURIComponent(resultUrl)}` : "#";
    this.elements.openGantt.setAttribute("aria-disabled", resultUrl ? "false" : "true");
    if (this.elements.exportDiagnosticButton) {
      this.elements.exportDiagnosticButton.disabled = !this.replayPlan;
    }
    this.elements.resultButton.disabled = false;
    this.showSingleResult();
    this.setTopologyVisible(true);
    this.render(snapshot);
    await this.renderPerformance();
  }
  /** 绑定文件、时间轴、播放和快捷控制事件。 */
  bindEvents() {
    this.elements.importButton?.addEventListener("click", () => this.elements.fileInput.click());
    this.elements.exportDiagnosticButton?.addEventListener("click", () => {
      void this.exportDeadlockDiagnostic();
    });
    this.elements.fileInput.addEventListener("change", () => {
      const file = this.elements.fileInput.files?.item(0);
      if (!file) return;
      this.loadFile(file).catch((error) => this.showError(error instanceof Error ? error.message : String(error))).finally(() => {
        this.elements.fileInput.value = "";
      });
    });
    this.elements.range.addEventListener("input", () => {
      this.time = finiteNumber(this.elements.range.value);
      this.render();
    });
    this.elements.playButton.addEventListener("click", () => {
      if (this.playing) this.pause();
      else this.play();
    });
    this.elements.actionStatusFilters.forEach((filter) => filter.addEventListener("change", () => {
      this.actionStatusFilters = this.elements.actionStatusFilters.filter((item) => item.checked).map((item) => item.value);
      this.render();
    }));
    this.elements.speed.addEventListener("change", () => {
      this.playbackSpeed = Math.max(0.25, finiteNumber(this.elements.speed.value, DEFAULT_PLAYBACK_SPEED));
    });
    this.elements.performanceWindow.addEventListener("change", () => {
      this.performanceWindowMode = this.elements.performanceWindow.value === "full" ? "full" : "steady";
      void this.renderPerformance();
    });
    this.elements.resultButton.addEventListener("click", () => this.show());
    this.elements.openGantt.addEventListener("click", (event) => {
      if (this.elements.openGantt.getAttribute("aria-disabled") === "true") event.preventDefault();
    });
  }
  /** 导出当前回放帧及算法候选动作，供离线复现死锁。 */
  async exportDeadlockDiagnostic() {
    if (!this.moves.length || !this.replayPlan) {
      this.showError("\u5F53\u524D MoveList \u7F3A\u5C11\u5B8C\u6574\u8BA1\u5212\uFF0C\u65E0\u6CD5\u91CD\u5EFA Machine \u8BCA\u65AD\u4E0A\u4E0B\u6587");
      return;
    }
    const button = this.elements.exportDiagnosticButton;
    if (button) button.disabled = true;
    try {
      const snapshot = buildWorkspaceSnapshot(
        this.moves,
        this.device,
        this.time,
        this.loadPortReplenishments
      );
      const result = await requestDeadlockDiagnostic({
        resultId: this.analysisResultId || void 0,
        moves: this.analysisResultId ? void 0 : this.moves,
        plan: this.analysisResultId ? void 0 : this.replayPlan,
        time: this.time,
        snapshot
      });
      const downloadUrl = URL.createObjectURL(result.blob);
      const link = this.root.createElement("a");
      link.href = downloadUrl;
      link.download = result.fileName;
      link.click();
      URL.revokeObjectURL(downloadUrl);
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
    } finally {
      if (button) button.disabled = false;
    }
  }
  /** 从当前时间开始播放；到达末尾时自动回到起点。 */
  play() {
    if (!this.moves.length || this.playing) return;
    const endTime = finiteNumber(this.elements.range.max);
    if (this.time >= endTime) {
      this.time = 0;
      this.elements.range.value = "0";
    }
    this.playing = true;
    this.previousFrameTime = performance.now();
    this.previousRenderTime = 0;
    this.updatePlayButton();
    this.animationFrame = requestAnimationFrame((timestamp) => this.tick(timestamp));
  }
  /** 暂停回放并保留当前时间。 */
  pause() {
    this.playing = false;
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.updatePlayButton();
  }
  /** 推进播放时钟，并按固定上限刷新 DOM。 */
  tick(timestamp) {
    if (!this.playing) return;
    const elapsedSeconds = Math.max(0, timestamp - this.previousFrameTime) / 1e3;
    this.previousFrameTime = timestamp;
    const endTime = finiteNumber(this.elements.range.max);
    const advancedTime = Math.min(endTime, this.time + elapsedSeconds * this.playbackSpeed);
    this.time = advancedTime;
    this.elements.range.value = String(this.time);
    if (timestamp - this.previousRenderTime >= PLAYBACK_FRAME_INTERVAL_MS || this.time >= endTime) {
      this.previousRenderTime = timestamp;
      this.render();
    }
    if (!this.playing) return;
    if (this.time >= endTime) {
      this.pause();
      return;
    }
    this.animationFrame = requestAnimationFrame((nextTimestamp) => this.tick(nextTimestamp));
  }
  /** 同步播放按钮的图标和无障碍文本。 */
  updatePlayButton() {
    this.elements.playButton.innerHTML = this.playing ? `${icon("pause")}<span>\u6682\u505C</span>` : `${icon("play")}<span>\u64AD\u653E</span>`;
    this.elements.playButton.setAttribute("aria-label", this.playing ? "\u6682\u505C\u56DE\u653E" : "\u64AD\u653E\u56DE\u653E");
    this.elements.playButton.classList.toggle("is-playing", this.playing);
  }
  /** 切换单例分析模式，测试组统计与单例诊断不会同时出现。 */
  showSingleResult() {
    this.elements.toolbar.hidden = false;
    this.elements.groupAnalysis.hidden = true;
    this.elements.empty.hidden = true;
    this.elements.content.hidden = false;
    this.elements.playbackEmpty.hidden = true;
  }
  /** 统一切换独立回放页中的概要、时间轴、拓扑与当前动作。 */
  setTopologyVisible(visible) {
    if (!visible) this.pause();
    this.elements.topologyPlayback.hidden = !visible;
    this.elements.playbackEmpty.hidden = visible;
  }
  /** 绘制当前时间对应的设备快照。 */
  render(prebuiltSnapshot) {
    if (!this.moves.length && !this.liveSolving) return;
    const snapshot = prebuiltSnapshot ?? buildWorkspaceSnapshot(
      this.moves,
      this.device,
      this.time,
      this.loadPortReplenishments
    );
    this.time = snapshot.time;
    this.elements.source.textContent = this.sourceName;
    this.elements.source.title = this.sourceName;
    this.elements.currentTime.textContent = formatSeconds2(snapshot.time);
    this.elements.totalTime.textContent = formatSeconds2(snapshot.endTime);
    this.elements.progressText.textContent = snapshot.endTime > 0 ? `${Math.round(snapshot.time / snapshot.endTime * 100)}%` : "0%";
    this.elements.moveText.textContent = `${snapshot.completedMoves} / ${snapshot.totalMoves}`;
    this.elements.waferText.textContent = String(snapshot.waferCount);
    this.elements.range.value = String(snapshot.time);
    const replayTime = this.replayDecisionTime(snapshot.time);
    const replayKey = this.replayStateKey(replayTime);
    const cachedDecision = this.replayDecisionCache.get(replayKey) ?? null;
    if (cachedDecision) {
      this.liveDecision = cachedDecision;
      this.liveDecisionKey = replayKey;
    }
    const currentDecision = cachedDecision ?? (this.liveDecisionKey === replayKey ? this.liveDecision : null);
    if (this.replayPlan && !this.liveSolving && !cachedDecision && this.liveDecisionKey !== replayKey && !this.pendingReplayDecisionKeys.has(replayKey) && this.replayDecisionErrorKey !== replayKey) {
      void this.refreshReplayDecision(replayKey, replayTime);
    }
    const topologySnapshot = snapshotWithFullDeviceModules(
      snapshotWithCandidateModules(snapshot, currentDecision, this.device),
      this.device
    );
    this.elements.stage.innerHTML = renderEquipmentTopology(
      topologySnapshot,
      currentDecision,
      void 0,
      this.device
    );
    const topologyCanvas = this.elements.stage.querySelector(".reference-grid-canvas");
    const canvasHeight = topologyCanvas?.style.getPropertyValue("--topology-canvas-height") ?? "";
    this.elements.frontSlotOverview.style.setProperty("--topology-canvas-height", canvasHeight);
    this.elements.frontSlotOverview.innerHTML = renderFrontSlotOverview(
      topologySnapshot.modules,
      topologySnapshot.waferOrigins,
      topologySnapshot.robots,
      this.device ? detectDeviceTopologyLayout(this.device) : detectTopologyLayout(topologySnapshot.modules, topologySnapshot.robots.length),
      this.device
    );
    const requestState = this.pendingReplayDecisionKeys.has(replayKey) ? "loading" : this.replayDecisionErrorKey === replayKey ? "error" : "idle";
    this.elements.decisionLens.innerHTML = renderDecisionLens(
      currentDecision,
      requestState,
      this.replayDecisionErrorMessage,
      this.actionStatusFilters
    );
    this.elements.activeMoves.innerHTML = snapshot.activeMoves.length ? snapshot.activeMoves.map((move) => `
        <li>
          <span class="active-move-id">#${finiteNumber(move.MoveID)}</span>
          <strong>${escapeHtml(MOVE_NAMES[finiteNumber(move.MoveType, -1)] ?? `\u52A8\u4F5C ${move.MoveType}`)}</strong>
          <span>${escapeHtml(move.ModuleName || activeTarget(move) || "\u2014")}</span>
          <time>${formatSeconds2(finiteNumber(move.StartTime))}\u2013${formatSeconds2(finiteNumber(move.EndTime))} s</time>
        </li>`).join("") : '<li class="active-move-empty">\u5F53\u524D\u65F6\u523B\u6CA1\u6709\u6267\u884C\u4E2D\u7684\u52A8\u4F5C</li>';
  }
  /** 返回不晚于当前时刻的最近原子动作边界。 */
  replayDecisionTime(time) {
    let decisionTime = 0;
    for (const boundary of this.currentDecisionBoundaries()) {
      if (boundary > time + PERFORMANCE_DISPLAY_TOLERANCE) break;
      decisionTime = boundary;
    }
    return decisionTime;
  }
  /** 动作接口在每个 Pick、Place、Swap 完成边界更新。 */
  currentDecisionBoundaries() {
    return this.primitiveDecisionBoundaries;
  }
  /** 每个原子动作边界只请求一次算法接口。 */
  replayStateKey(replayTime) {
    return `actions@${replayTime.toFixed(6)}`;
  }
  /** 异步请求当前 Machine 候选；过期响应不会覆盖用户已经拖到的新时刻。 */
  async refreshReplayDecision(replayKey, replayTime) {
    const requestVersion = ++this.replayDecisionRequestVersion;
    this.pendingReplayDecisionKeys.add(replayKey);
    if (this.replayDecisionErrorKey === replayKey) {
      this.replayDecisionErrorKey = "";
      this.replayDecisionErrorMessage = "";
    }
    let renderFailure = false;
    try {
      const rawDecision = await requestReplayDecision({
        resultId: this.analysisResultId || void 0,
        moves: this.analysisResultId ? void 0 : this.moves,
        plan: this.replayPlan,
        time: replayTime
      });
      const decision = normalizeDecisionTrace({ DecisionTrace: [rawDecision] })[0] ?? null;
      if (requestVersion !== this.replayDecisionRequestVersion || !decision) return;
      this.replayDecisionCache.set(replayKey, decision);
      const currentReplayTime = this.replayDecisionTime(this.time);
      if (this.replayStateKey(currentReplayTime) !== replayKey) return;
      this.liveDecision = decision;
      this.liveDecisionKey = replayKey;
      this.render();
    } catch (error) {
      if (requestVersion === this.replayDecisionRequestVersion) {
        this.replayDecisionErrorKey = replayKey;
        this.replayDecisionErrorMessage = error instanceof Error ? error.message : String(error);
        renderFailure = true;
      }
    } finally {
      this.pendingReplayDecisionKeys.delete(replayKey);
      if (renderFailure && this.replayStateKey(this.replayDecisionTime(this.time)) === replayKey) {
        this.render();
      }
    }
  }
  /** 请求并绘制与播放时刻无关的服务端排程性能诊断。 */
  async renderPerformance() {
    if (!this.moves.length) return;
    const requestVersion = ++this.analysisRequestVersion;
    this.elements.performance.innerHTML = `
      <section class="result-card analysis-skeleton" aria-label="\u6B63\u5728\u52A0\u8F7D\u7ED3\u679C\u5206\u6790">
        <div class="analysis-skeleton-head"><i></i><span></span></div>
        <div class="analysis-skeleton-grid">${Array.from({ length: 6 }, () => "<span></span>").join("")}</div>
      </section>`;
    try {
      const result = await requestScheduleAnalysis({
        ...this.analysisResultId ? { resultId: this.analysisResultId } : { moves: this.moves },
        device: this.device,
        windowMode: this.performanceWindowMode,
        routes: this.analysisRoutes,
        rounds: this.analysisRounds,
        cpuTimeMs: this.analysisResultId ? void 0 : this.cpuTimeMs,
        recomputeCount: this.analysisResultId ? void 0 : this.recomputeCount
      });
      if (requestVersion !== this.analysisRequestVersion) return;
      const analysis = result.analysis;
      this.analysis = analysis;
      this.bottleneckSummary = result.bottleneck;
      this.elements.performance.innerHTML = renderSchedulePerformance(analysis);
      const windowSlot = this.elements.performance.querySelector(".bottleneck-window-slot");
      if (windowSlot) {
        this.elements.performanceWindow.tabIndex = 0;
        windowSlot.append(this.elements.performanceWindow);
      }
      this.elements.performance.querySelectorAll(".residence-metric-scroll").forEach((scroller) => {
        scroller.scrollLeft = scroller.scrollWidth;
      });
    } catch (error) {
      if (requestVersion !== this.analysisRequestVersion) return;
      this.analysis = null;
      this.bottleneckSummary = null;
      this.elements.performance.innerHTML = `
        <div class="analysis-error-state">
          <strong>\u6570\u636E\u83B7\u53D6\u5931\u8D25</strong>
          <span>${escapeHtml(error instanceof Error ? error.message : String(error))}</span>
          <button class="analysis-secondary-button" type="button" data-performance-retry>\u91CD\u65B0\u52A0\u8F7D</button>
        </div>`;
      this.elements.performance.querySelector("[data-performance-retry]")?.addEventListener("click", () => {
        void this.renderPerformance();
      });
    }
  }
  /** 显示加载状态并保留明确的系统反馈。 */
  setLoading(loading, message) {
    this.pause();
    this.setTopologyVisible(false);
    this.elements.toolbar.hidden = false;
    this.elements.groupAnalysis.hidden = true;
    this.elements.content.hidden = true;
    this.elements.empty.hidden = false;
    this.elements.playbackEmpty.hidden = false;
    this.elements.empty.classList.toggle("is-loading", loading);
    this.elements.playbackEmpty.classList.toggle("is-loading", loading);
    this.elements.empty.classList.remove("is-error");
    this.elements.playbackEmpty.classList.remove("is-error");
    const loadingMarkup = loading ? `<span class="visual-loader" aria-hidden="true"></span><strong>${escapeHtml(message)}</strong>` : `<strong>${escapeHtml(message)}</strong>`;
    this.elements.empty.innerHTML = loadingMarkup;
    this.elements.playbackEmpty.innerHTML = loadingMarkup;
  }
  /** 在工作台空状态中显示可恢复的错误。 */
  showError(message) {
    this.pause();
    this.setTopologyVisible(false);
    this.elements.toolbar.hidden = false;
    this.elements.groupAnalysis.hidden = true;
    this.elements.content.hidden = true;
    this.elements.empty.hidden = false;
    this.elements.playbackEmpty.hidden = false;
    this.elements.empty.classList.remove("is-loading");
    this.elements.playbackEmpty.classList.remove("is-loading");
    this.elements.empty.classList.add("is-error");
    this.elements.playbackEmpty.classList.add("is-error");
    const errorMarkup = `
      <strong>\u65E0\u6CD5\u52A0\u8F7D MoveList</strong>
      <span>${escapeHtml(message)}</span>
      <label class="btn visual-import-button">${icon("upload")}\u91CD\u65B0\u9009\u62E9\u6587\u4EF6<input type="file" accept=".json,application/json" data-visual-retry></label>`;
    this.elements.empty.innerHTML = errorMarkup;
    this.elements.playbackEmpty.innerHTML = errorMarkup;
    [this.elements.empty, this.elements.playbackEmpty].forEach((container) => {
      const retryInput = container.querySelector("[data-visual-retry]");
      retryInput?.addEventListener("change", () => {
        const file = retryInput.files?.item(0);
        if (file) this.loadFile(file).catch((error) => this.showError(error instanceof Error ? error.message : String(error)));
      });
    });
  }
};
function createVisualizationWorkspace(root = document) {
  return new VisualizationWorkspace(root);
}

// src/group_analysis_view.ts
function escapeHtml2(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function finiteText(value, digits, suffix = "") {
  return value === null || !Number.isFinite(value) ? "\u2014" : `${value.toFixed(digits)}${suffix}`;
}
function percentText(value, fromRatio = false) {
  const normalized = value === null ? null : value * (fromRatio ? 100 : 1);
  return finiteText(normalized, 2, "%");
}
function durationText(value) {
  if (value === null || !Number.isFinite(value)) return "\u2014";
  return value >= 1e3 ? `${(value / 1e3).toFixed(2)} s` : `${value.toFixed(1)} ms`;
}
function caseLabel(item, index) {
  return item.name || `t${index + 1}`;
}
function csvEscape(value) {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
function testGroupSummaryCsv(summary) {
  const headers = [
    "\u6D4B\u8BD5",
    "Makespan",
    "Baseline",
    "\u6539\u5584",
    "\u74F6\u9888",
    "\u5229\u7528\u7387",
    "CPU Time",
    "\u4EA7\u80FD",
    "\u51FA\u7AD9 CV",
    "\u52A0\u5DE5\u8154\u9A7B\u7559\u5747\u503C",
    "\u673A\u5668\u624B\u9A7B\u7559\u5747\u503C",
    "\u7CFB\u7EDF\u505C\u7559\u5747\u503C",
    "\u7CFB\u7EDF\u505C\u7559 CV",
    "\u6821\u9A8C"
  ];
  const rows = summary.cases.map((item, index) => [
    caseLabel(item, index),
    finiteText(item.makespan, 2, " s"),
    finiteText(item.baselineMakespan, 2, " s"),
    item.improvementPercent === null ? "\u2014" : `${item.improvementPercent > 0 ? "+" : ""}${item.improvementPercent.toFixed(2)}%`,
    `${item.bottleneckResource || "\u2014"}${item.bottleneckCandidateCount > 1 ? ` +${item.bottleneckCandidateCount - 1} \u4E2A\u5019\u9009` : ""}`,
    percentText(item.bottleneckUtilization, true),
    durationText(item.cpuTimeMs),
    finiteText(item.throughputPerHour, 1, " \u7247/h"),
    finiteText(item.departureIntervalCv, 2),
    finiteText(item.processChamberDwellMeanSeconds, 2, " s"),
    finiteText(item.robotWaferDwellMeanSeconds, 2, " s"),
    finiteText(item.waferSystemResidenceMeanSeconds, 2, " s"),
    finiteText(item.waferSystemResidenceCv, 2),
    item.validationPassed ? "\u901A\u8FC7" : item.validation || item.status || "\u2014"
  ].map(csvEscape));
  return [headers.map(csvEscape).join(","), ...rows.map((row) => row.join(","))].join("\r\n");
}
function resultTable(summary, selected) {
  return summary.cases.map((item, index) => {
    const cells = [`<th scope="row">${escapeHtml2(caseLabel(item, index))}</th>`];
    if (selected.has("makespan")) {
      cells.push(`<td>${finiteText(item.makespan, 2, " s")}</td>`);
      cells.push(`<td>${item.id === summary.referenceCaseId ? '<span class="group-reference">\u53C2\u8003</span>' : item.referenceDeltas?.makespan?.percent === void 0 ? "\u2014" : item.referenceComparable ? `${item.referenceDeltas.makespan.percent > 0 ? "+" : ""}${item.referenceDeltas.makespan.percent.toFixed(2)}%` : '<span title="\u8FD0\u884C\u914D\u7F6E\u4E0D\u540C\uFF0C\u53EA\u5E76\u5217\u5C55\u793A\u6570\u503C">\u4EC5\u89C2\u5BDF</span>'}</td>`);
    }
    if (selected.has("baseline_improvement")) {
      cells.push(`<td>${finiteText(item.baselineMakespan, 2, " s")}</td>`);
      cells.push(`<td class="${(item.improvementPercent ?? 0) < 0 ? "loss" : "gain"}">${item.improvementPercent === null ? "\u2014" : `${item.improvementPercent > 0 ? "+" : ""}${item.improvementPercent.toFixed(2)}%`}</td>`);
    }
    if (selected.has("bottleneck_candidates")) cells.push(`<td>${escapeHtml2(item.bottleneckResource || "\u2014")}${item.bottleneckCandidateCount > 1 ? ` <small>+${item.bottleneckCandidateCount - 1} \u4E2A\u5019\u9009</small>` : ""}</td>`);
    if (selected.has("resource_utilization")) cells.push(`<td>${percentText(item.bottleneckUtilization, true)}</td>`);
    if (selected.has("cpu_time")) cells.push(`<td>${durationText(item.cpuTimeMs)}</td>`);
    if (selected.has("average_recompute_time")) cells.push(`<td>${durationText(item.averageRecomputeTimeMs ?? null)}</td>`);
    if (selected.has("throughput")) cells.push(`<td>${finiteText(item.throughputPerHour, 1, " \u7247/h")}</td>`);
    if (selected.has("departure_interval_cv")) cells.push(`<td>${finiteText(item.departureIntervalCv, 2)}</td>`);
    if (selected.has("process_chamber_dwell")) cells.push(`<td>${finiteText(item.processChamberDwellMeanSeconds, 2, " s")}</td>`);
    if (selected.has("robot_wafer_dwell")) cells.push(`<td>${finiteText(item.robotWaferDwellMeanSeconds, 2, " s")}</td>`);
    if (selected.has("system_residence")) cells.push(`<td>${finiteText(item.waferSystemResidenceMeanSeconds, 2, " s")}</td>`);
    if (selected.has("system_residence_cv")) cells.push(`<td>${finiteText(item.waferSystemResidenceCv, 2)}</td>`);
    if (selected.has("loadlock_wafers_per_cycle")) cells.push(`<td>${finiteText(item.loadLockWafersPerCycle, 2, " \u7247")}</td>`);
    if (selected.has("loadlock_full_cycle_ratio")) cells.push(`<td>${percentText(item.loadLockFullCycleRatio, true)}</td>`);
    if (selected.has("loadlock_empty_cycle_ratio")) cells.push(`<td>${percentText(item.loadLockEmptyCycleRatio, true)}</td>`);
    if (selected.has("validation")) cells.push(`<td>${item.analysisStatus && item.analysisStatus !== "completed" ? `<span class="group-fail">${escapeHtml2(item.error || item.analysisStatus)}</span>` : item.validationPassed ? '<span class="group-pass">\u901A\u8FC7</span>' : `<span class="group-fail">${escapeHtml2(item.validation || item.status)}</span>`}</td>`);
    const rowClasses = [
      item.id === summary.referenceCaseId ? "is-reference" : "",
      item.analysisStatus && item.analysisStatus !== "completed" ? "is-incomplete" : ""
    ].filter(Boolean).join(" ");
    return `<tr${rowClasses ? ` class="${rowClasses}"` : ""}>${cells.join("")}</tr>`;
  }).join("");
}
function renderTestGroupAnalysis(summary, groupName) {
  const selected = new Set(summary.selectedMetricIds ?? [
    "validation",
    "makespan",
    "baseline_improvement",
    "cpu_time",
    "throughput",
    "departure_interval_cv",
    "process_chamber_dwell",
    "robot_wafer_dwell",
    "system_residence",
    "system_residence_cv",
    "resource_utilization",
    "bottleneck_candidates"
  ]);
  const reference = summary.cases.find((item) => item.id === summary.referenceCaseId);
  const selectedLabels = {
    validation: "\u6821\u9A8C\u7ED3\u679C",
    makespan: "Makespan",
    baseline_improvement: "Baseline \u6539\u5584",
    cpu_time: "CPU Time",
    average_recompute_time: "\u5E73\u5747\u91CD\u7B97\u65F6\u95F4",
    throughput: "\u4EA7\u80FD",
    departure_interval_cv: "\u51FA\u7AD9\u95F4\u9694 CV",
    process_chamber_dwell: "\u52A0\u5DE5\u8154\u9A7B\u7559",
    robot_wafer_dwell: "\u673A\u5668\u624B\u9A7B\u7559",
    system_residence: "\u7CFB\u7EDF\u505C\u7559",
    system_residence_cv: "\u7CFB\u7EDF\u505C\u7559 CV",
    resource_utilization: "\u8D44\u6E90\u5229\u7528\u7387",
    bottleneck_candidates: "\u74F6\u9888\u5019\u9009",
    loadlock_wafers_per_cycle: "LoadLock \u6BCF\u5468\u671F\u6676\u5706",
    loadlock_full_cycle_ratio: "LoadLock \u6EE1\u8F7D\u5468\u671F\u7387",
    loadlock_empty_cycle_ratio: "LoadLock \u7A7A\u8F7D\u5468\u671F\u7387"
  };
  const tableHeaders = ["<th>\u6D4B\u8BD5</th>"];
  if (selected.has("makespan")) tableHeaders.push("<th>Makespan</th>", "<th>\u76F8\u5BF9\u53C2\u8003</th>");
  if (selected.has("baseline_improvement")) tableHeaders.push("<th>Baseline</th>", "<th>\u6539\u5584</th>");
  if (selected.has("bottleneck_candidates")) tableHeaders.push("<th>\u74F6\u9888</th>");
  if (selected.has("resource_utilization")) tableHeaders.push("<th>\u5229\u7528\u7387</th>");
  if (selected.has("cpu_time")) tableHeaders.push("<th>CPU Time</th>");
  if (selected.has("average_recompute_time")) tableHeaders.push("<th>\u5E73\u5747\u91CD\u7B97\u65F6\u95F4</th>");
  if (selected.has("throughput")) tableHeaders.push("<th>\u4EA7\u80FD</th>");
  if (selected.has("departure_interval_cv")) tableHeaders.push("<th>\u51FA\u7AD9 CV</th>");
  if (selected.has("process_chamber_dwell")) tableHeaders.push("<th>\u52A0\u5DE5\u8154\u9A7B\u7559\u5747\u503C</th>");
  if (selected.has("robot_wafer_dwell")) tableHeaders.push("<th>\u673A\u5668\u624B\u9A7B\u7559\u5747\u503C</th>");
  if (selected.has("system_residence")) tableHeaders.push("<th>\u7CFB\u7EDF\u505C\u7559\u5747\u503C</th>");
  if (selected.has("system_residence_cv")) tableHeaders.push("<th>\u7CFB\u7EDF\u505C\u7559 CV</th>");
  if (selected.has("loadlock_wafers_per_cycle")) tableHeaders.push("<th>LoadLock \u6BCF\u5468\u671F\u6676\u5706</th>");
  if (selected.has("loadlock_full_cycle_ratio")) tableHeaders.push("<th>LoadLock \u6EE1\u8F7D\u5468\u671F\u7387</th>");
  if (selected.has("loadlock_empty_cycle_ratio")) tableHeaders.push("<th>LoadLock \u7A7A\u8F7D\u5468\u671F\u7387</th>");
  if (selected.has("validation")) tableHeaders.push("<th>\u6821\u9A8C</th>");
  return `
    <div class="group-analysis-head">
      <div><h2>${escapeHtml2(groupName || "\u5F53\u524D\u6D4B\u8BD5\u7EC4")}</h2><p>\u53C2\u8003\u6D4B\u8BD5\uFF1A${escapeHtml2(reference?.name || "\u9996\u4E2A\u6D4B\u8BD5")} \xB7 ${summary.cacheHitCount ?? 0} \u9879\u547D\u4E2D\u7F13\u5B58</p></div>
      <button class="btn small" type="button" data-reconfigure-analysis>\u91CD\u65B0\u9009\u62E9\u6307\u6807\u4E0E\u6D4B\u8BD5</button>
    </div>
    <div class="group-analysis-selection">${[...selected].map((metric) => `<span>${escapeHtml2(selectedLabels[metric] || metric)}</span>`).join("")}</div>
    ${summary.timedOut ? '<div class="group-analysis-warning">\u5DF2\u8FBE\u5230\u65F6\u95F4\u9884\u7B97\uFF0C\u4EE5\u4E0B\u62A5\u544A\u4FDD\u7559\u5B8C\u6210\u90E8\u5206\uFF1B\u53EF\u51CF\u5C11\u6307\u6807\u6216\u63D0\u9AD8\u65F6\u95F4\u9884\u7B97\u540E\u7EE7\u7EED\u3002</div>' : ""}
    <section class="group-analysis-table-wrap">
      <div class="group-analysis-table-head"><div><strong>\u9010\u6D4B\u8BD5\u6307\u6807\u5BF9\u6BD4</strong><small>${summary.cases.length} \u4E2A\u6D4B\u8BD5 \xB7 ${selected.size} \u9879\u6307\u6807 \xB7 \u53C2\u8003\u9879\u5DF2\u9AD8\u4EAE</small></div><button type="button" class="btn small group-analysis-export" data-group-export-csv>\u5BFC\u51FA CSV</button></div>
      <div class="group-analysis-table-scroll">
        <table class="group-analysis-table">
          <caption class="sr-only">${escapeHtml2(groupName || "\u5F53\u524D\u6D4B\u8BD5\u7EC4")}\u9010\u6D4B\u8BD5\u6307\u6807\u5BF9\u6BD4</caption>
          <thead><tr>${tableHeaders.join("")}</tr></thead>
          <tbody>${resultTable(summary, selected)}</tbody>
        </table>
      </div>
    </section>`;
}

// src/editor_models.ts
var CJOB_TYPES = ["NormalLot", "HighestLot", "HigherLot"];
var TASK_MODES = ["Smart", "Pipeline", "Sequential", "Concurrent"];
function stringList(value) {
  const values3 = Array.isArray(value) ? value : String(value || "").replaceAll("\uFF0C", ",").split(",");
  return [...new Set(values3.map((item) => String(item).trim()).filter(Boolean))];
}
function makeVisit(stationName = "", processRecipe = "") {
  return {
    stationName,
    slotIds: "1",
    processRecipe,
    processTime: 20,
    recipeTime: 20,
    processType: "",
    weight: "{}",
    moveTimeOffset: "{}",
    qTimeLimit: -1,
    residencyConstraint: -1,
    beforeCleanRefs: [],
    afterCleanRefs: []
  };
}
function makeStage(stations = "", needProcess = false, recipeName = "") {
  const names = stringList(stations);
  const visits = (names.length ? names : [""]).map(
    (name) => makeVisit(name, needProcess ? recipeName : "")
  );
  return { stepId: 0, postStepIds: [], needProcess, visits };
}
function linkRouteSteps(stages) {
  stages.forEach((stage, index) => {
    stage.stepId = index;
    stage.postStepIds = index + 1 < stages.length ? [index + 1] : [];
  });
  return stages;
}
function normalizeVisit(visit, recipeName = "") {
  visit.processTime = Number(visit.processTime ?? visit.recipeTime ?? 20);
  visit.recipeTime = Number(visit.recipeTime ?? visit.processTime);
  visit.processRecipe = String(visit.processRecipe ?? "").trim() || String(recipeName).trim();
  visit.processType ??= "";
  visit.slotIds ??= "1";
  visit.weight ??= "{}";
  visit.moveTimeOffset ??= "{}";
  visit.qTimeLimit = Number(visit.qTimeLimit ?? -1);
  visit.residencyConstraint = Number(visit.residencyConstraint ?? -1);
  visit.beforeCleanRefs = Array.isArray(visit.beforeCleanRefs) ? visit.beforeCleanRefs : [];
  visit.afterCleanRefs = Array.isArray(visit.afterCleanRefs) ? visit.afterCleanRefs : [];
  return visit;
}
function makePJob(index = 1, routeRef = "", loadPort = "", waferCount = 5) {
  return {
    jobName: `P${index}`,
    taskId: "",
    waferCount,
    matList: Array.from({ length: waferCount }, (_, item) => item + 1),
    routeRef,
    routeConfig: null,
    loadPort,
    priority: 1
  };
}
function makeCJob(roundIndex, pjobs = [], routeRef = "", loadPort = "") {
  const rows = pjobs.length ? pjobs : [makePJob(1, routeRef, loadPort, 5)];
  return {
    key: "C1",
    taskId: String(roundIndex),
    jobType: "NormalLot",
    priority: 1,
    taskMode: "Smart",
    loadPort,
    cjobCycle: 1,
    pJobNameList: rows.map((item) => item.jobName),
    pjobs: rows
  };
}
function makeRound(roundIndex, currentTime, routeRef = "", loadPort = "") {
  return {
    currentTime: roundIndex === 1 ? 0 : currentTime,
    cjobs: [makeCJob(roundIndex, [], routeRef, loadPort)]
  };
}
function automaticLoadPort(loadPorts, taskOrdinal) {
  if (!loadPorts.length) return "";
  return loadPorts[Math.max(0, taskOrdinal - 1) % loadPorts.length];
}
function enumName(value, names, fallback) {
  if (names.includes(String(value))) return String(value);
  const numeric = Number(value);
  if (names === CJOB_TYPES) {
    return { 0: "NormalLot", 2: "HighestLot", 3: "HigherLot" }[numeric] || fallback;
  }
  return { 0: "Smart", 1: "Pipeline", 2: "Sequential", 3: "Concurrent" }[numeric] || fallback;
}
function normalizePJob(raw, index, taskId, assignedLoadPort = "") {
  const source = raw || {};
  const originRoute = source.originRoute ?? source.OriginRoute;
  const routeRef = typeof originRoute === "object" ? originRoute?.name || originRoute?.Name || "" : originRoute;
  const waferCount = Math.max(
    1,
    Math.min(25, Number(source.waferCount ?? source.matList?.length ?? source.MatList?.length ?? 1) || 1)
  );
  return {
    jobName: `P${index}`,
    taskId: String(taskId),
    waferCount,
    matList: Array.from({ length: waferCount }, (_, item) => item + 1),
    routeRef: source.routeRef || routeRef || "",
    routeConfig: source.routeConfig && typeof source.routeConfig === "object" ? structuredClone(source.routeConfig) : null,
    loadPort: assignedLoadPort || source.loadPort || source.LoadPort || "",
    priority: Math.max(1, Number(source.priority ?? source.Priority) || 1)
  };
}
function normalizeRound(raw, roundIndex, fallbackTime, firstTaskId = roundIndex, loadPorts = []) {
  const source = raw || {};
  let cjobs = Array.isArray(source.cjobs) ? source.cjobs : null;
  if (!cjobs) {
    const legacyJobs = Array.isArray(source.jobs) ? source.jobs : [];
    const first = legacyJobs[0] || {};
    cjobs = [{
      jobType: first.jobType,
      priority: first.priority,
      taskMode: first.taskMode,
      pjobs: legacyJobs.length ? legacyJobs : [{}]
    }];
  }
  if (!cjobs.length) cjobs = [{ pjobs: [{}] }];
  const normalizedCJobs = cjobs.map((cjob, cjobIndex) => {
    const taskId = String(firstTaskId + cjobIndex);
    const taskMode = enumName(cjob.taskMode, TASK_MODES, "Smart");
    const rawPJobs = Array.isArray(cjob.pjobs) && cjob.pjobs.length ? cjob.pjobs : [{}];
    const legacyLoadPort = cjob.loadPort || rawPJobs[0]?.loadPort || rawPJobs[0]?.LoadPort || "";
    const loadPort = (loadPorts.includes(String(legacyLoadPort)) ? String(legacyLoadPort) : "") || automaticLoadPort(loadPorts, firstTaskId + cjobIndex) || String(legacyLoadPort);
    const pjobs = rawPJobs.map(
      (pjob, pjobIndex) => normalizePJob(
        pjob,
        pjobIndex + 1,
        taskId,
        loadPort
      )
    );
    const jobType = enumName(cjob.jobType, CJOB_TYPES, "NormalLot");
    return {
      key: cjob.key || `C${cjobIndex + 1}`,
      taskId,
      loadPort,
      jobType,
      priority: jobType === "NormalLot" ? Math.max(1, Number(cjob.priority) || 1) : -1,
      taskMode,
      cjobCycle: Math.max(
        1,
        Math.min(1e3, Math.trunc(Number(
          cjob.cjobCycle ?? cjob.CJobCycle ?? cjob.jobCycle ?? cjob.JobCycle ?? 1
        ) || 1))
      ),
      pJobNameList: pjobs.map((pjob) => pjob.jobName),
      pjobs
    };
  });
  return {
    currentTime: roundIndex === 1 ? 0 : Number(source.currentTime ?? fallbackTime ?? 0),
    cjobs: normalizedCJobs
  };
}

// src/config_editor.ts
var { VISIT_SHARED_FIELDS: VISIT_SHARED_FIELDS2, automaticTemplateName: automaticTemplateName2 } = route_editor_logic_exports;
var visualizationWorkspace = createVisualizationWorkspace();
var batchPerformanceAnalyses = /* @__PURE__ */ new Map();
var batchBottleneckSummaries = /* @__PURE__ */ new Map();
var batchBottleneckRequests = /* @__PURE__ */ new Map();
var batchBottleneckErrors = /* @__PURE__ */ new Map();
var batchCardAnalyses = /* @__PURE__ */ new Map();
var batchCardAnalysisRequests = /* @__PURE__ */ new Map();
var activeGroupAnalysisJobId = "";
var analysisWizardStep = 1;
var analysisSettingsPreferencesDirty = false;
var EXPECTED_API_SCHEMA = "cjob-pjob-v3";
var DEFAULT_SCHEDULE_OPTIONS = Object.freeze({
  loadLockDirection: 1,
  loadLockCapacity: 1,
  loadLockBindBatch: 0,
  loadLockManager: "petri-look",
  residencyGuardSeconds: 0,
  maximumRobotHoldingSeconds: 0,
  maximumSystemResidenceCv: 0,
  loadLockMacroSearchSeconds: 4,
  loadLockMacroRollouts: 96,
  searchTreeModelPath: "",
  heuristicConfig: null,
  seed: 0
});
var DEFAULT_HEURISTIC_WEIGHTS = Object.freeze({
  feed_block_penalty: 4,
  earliest_start_weight: 0.35,
  finish_time_weight: 0.15,
  exchange_bonus: 2,
  process_departure_bonus: 1.6,
  into_process_bonus: 1.5,
  drain_bonus: 0.3,
  sink_bonus: 0.25,
  feed_penalty: -0.35,
  stage_progress_bonus: 0.2
});
var SCHEDULE_OPTION_KEYS = new Set(Object.keys(DEFAULT_SCHEDULE_OPTIONS));
var DEADLOCK_TYPE_CATALOG = Object.freeze({
  "DEADLOCK.SINGLE_ARM_TARGET_FULL": {
    deadlockCode: "DLK-ROB-001",
    title: "\u5355\u81C2\u673A\u5668\u624B\u6301\u7247\uFF0C\u76EE\u6807\u8154\u5BA4\u5DF2\u6EE1"
  },
  "DEADLOCK.DUAL_ARM_TARGETS_FULL": {
    deadlockCode: "DLK-ROB-002",
    title: "\u53CC\u81C2\u673A\u5668\u624B\u6301\u6709\u4E24\u7247\uFF0C\u76EE\u6807\u8154\u5BA4\u5747\u5DF2\u6EE1"
  }
});
function deadlockDisplay(deadlock) {
  if (!deadlock || typeof deadlock !== "object") return null;
  const code = String(deadlock.Code || "DEADLOCK.UNCLASSIFIED").toUpperCase();
  const registered = DEADLOCK_TYPE_CATALOG[code];
  if (registered) return { internalCode: code, ...registered, message: String(deadlock.Message || "") };
  return {
    internalCode: "DEADLOCK.UNCLASSIFIED",
    deadlockCode: "DLK-UNK",
    title: "\u5F53\u524D\u73B0\u573A\u4E0D\u6EE1\u8DB3\u8FD9\u4E24\u79CD\u7C7B\u578B\uFF0C\u7B97\u6CD5\u62A5\u544A\u65E0\u6CD5\u7EE7\u7EED\u8C03\u5EA6\u3002",
    message: "\u5F53\u524D\u73B0\u573A\u4E0D\u6EE1\u8DB3\u8FD9\u4E24\u79CD\u7C7B\u578B\uFF0C\u7B97\u6CD5\u62A5\u544A\u65E0\u6CD5\u7EE7\u7EED\u8C03\u5EA6\u3002"
  };
}
var CLEAN_TYPE_DEFINITIONS = [
  { key: "preclean", label: "PreClean" },
  { key: "postclean", label: "PostClean" },
  { key: "wacclean", label: "WAC Clean" },
  { key: "dummy", label: "Dummy" },
  { key: "dummywac", label: "Dummy WAC" }
];
var ROUTE_CLEAN_KEYS = ["prePJobCleanRefs", "postPJobCleanRefs", "postCJobCleanRefs"];
var PROCESSING_STATION_TYPES = /* @__PURE__ */ new Set([
  "processchamber",
  "multiprocesschamber",
  "heater",
  "cooler"
]);
var FIRST_ROBOT_SLOT_ID = 1;
var DUAL_ARM_SLOT_COUNT = 2;
var BATCH_STATUS_POLL_MILLISECONDS = 1e3;
var WORKSPACE_TRANSFER_POLL_MILLISECONDS = 500;
var TEST_ORDER_COLLATOR = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
var DEFAULT_DUMMY_WAFER_COUNT = 8;
var STATION_ACTION_TIME_FIELDS = [
  { key: "PickPrepareTime", label: "PickPrepareTime" },
  { key: "PickCompleteTime", label: "PickCompleteTime" },
  { key: "PlacePrepareTime", label: "PlacePrepareTime" },
  { key: "PlaceCompleteTime", label: "PlaceCompleteTime" },
  { key: "PostCompleteTime", label: "PostCompleteTime" }
];
var ROBOT_ACTION_TIME_FIELDS = [
  { key: "PickTime", label: "PickTime" },
  { key: "PlaceTime", label: "PlaceTime" }
];
var state = {
  workspaceDevices: [],
  workspaceDevice: null,
  workspaceDeviceId: "",
  testCaseId: "",
  testCaseName: "",
  testCaseGroup: "",
  activeTestGroup: "",
  serviceCompatible: false,
  dirty: false,
  activeBatchId: "",
  batchRunning: false,
  batchCancelRequested: false,
  batchCancelSent: false,
  batchResult: null,
  selectedBatchTestId: "",
  deviceName: "",
  baseDevice: null,
  device: null,
  stationNames: [],
  loadPorts: [],
  processModules: [],
  robotNames: [],
  robotScopes: {},
  robotSlots: {},
  robotSlotsSaving: /* @__PURE__ */ new Set(),
  deviceConfigSection: "station-time",
  deviceStationName: "",
  deviceRobotName: "",
  deviceRobotTransferAxes: {},
  deviceRobotTransferSources: {},
  deviceTimingDraft: null,
  deviceTimingDirty: false,
  deviceTimingSaving: false,
  deviceTimingStatusMessage: "\u9009\u62E9\u8BBE\u5907\u540E\u5F00\u59CB\u914D\u7F6E",
  strategy: "heuristic",
  availableAlgorithms: [],
  algorithmMetadata: {},
  roundCount: 2,
  times: [0, 70],
  options: { ...DEFAULT_SCHEDULE_OPTIONS },
  cleans: [],
  routes: [{ name: "RouteA", group: "RouteA", bufferOption: 0, prePJobCleanRefs: [], postPJobCleanRefs: [], postCJobCleanRefs: [], stages: linkRouteSteps([makeStage("LP1"), makeStage("Robot"), makeStage("PM1,PM2", true, "RouteA_Step2"), makeStage("Robot"), makeStage("LP1")]) }],
  rounds: [makeRound(1, 0, "RouteA", "LP1"), makeRound(2, 70, "RouteA", "LP2")],
  testRouteConfigs: {},
  routeDirty: false,
  routeGroupingProfiles: /* @__PURE__ */ new Map(),
  routeEditingIndex: -1,
  routeEditSnapshot: null,
  routeEditGroupingProfile: null,
  routeEditIsNew: false,
  drawer: null,
  cleanDialogContext: null,
  expandedRouteProcessGroups: /* @__PURE__ */ new Set(),
  expandedRouteGroups: /* @__PURE__ */ new Set(),
  expandedRoutes: /* @__PURE__ */ new Set(),
  routeNameChanges: /* @__PURE__ */ new Map(),
  routeProcessFilter: "",
  routeParallelFilter: ""
};
var pjobRoutePickerContext = null;
var searchTelemetryPollToken = 0;
var latestSearchTelemetry = null;
var selectedSearchTelemetryId = "";
var followLatestSearchTelemetry = true;
var searchTelemetryRunActive = false;
var searchTelemetryControlPending = false;
var lastSearchTelemetryMoveCount = 0;
var lastBatchItemsRenderSignature = "";
var continuousDecisionEnabled = false;
var continuousDecisionSubmittedSearchId = "";
var userChosenActionKey = "";
var userChosenSearchId = "";
var singleRunActive = false;
var singleRunCancelling = false;
var activeSingleRunId = "";
var singleRunAbortController = null;
var runStatusStartedAt = 0;
var runStatusElapsedMs = 0;
var runStatusTimer = 0;
var pendingSearchTreeCheckpointFile = null;
var dataTransferMode = "import";
var sessionSchedulingConfiguration = null;
function retainSessionSchedulingConfiguration() {
  sessionSchedulingConfiguration = structuredClone({
    strategy: state.strategy,
    options: state.options
  });
}
function inferCleanType(clean) {
  const explicit = String(clean.cleanType || clean.category || "").toLowerCase().replace(/[-_\s]/g, "");
  if (["preclean", "postclean", "wacclean", "dummy", "dummywac"].includes(explicit)) return explicit;
  if (explicit === "dummyclean") return "dummy";
  if (explicit === "dummywacclean") return "dummywac";
  const signature = `${clean.taskName || ""} ${clean.name || ""}`.toLowerCase();
  if (/dummy.*wac|wac.*dummy|prewac/.test(signature) || clean.emptyRecipeRef) return "dummywac";
  if (Number(clean.materialCount || 0) > 0 || /dummy/.test(signature)) return "dummy";
  if (String(clean.stateVariable || "").toLowerCase() === "processcount" || /wac/.test(signature)) return "wacclean";
  if (/post/.test(signature)) return "postclean";
  return "preclean";
}
function normalizeClean(clean) {
  const value = { ...clean || {} }, cleanType = inferCleanType(value);
  const isDummy = cleanType === "dummy" || cleanType === "dummywac";
  const name = String(value.name || `Clean${state.cleans.length + 1}`).trim() || `Clean${state.cleans.length + 1}`;
  value.name = name;
  value.cleanType = cleanType;
  value.recipeName = String(value.recipeName || value.recipeRef || `${name}-Recipe`).trim() || `${name}-Recipe`;
  const recipeTime = Number(value.recipeTime);
  value.recipeTime = Math.max(0, Number.isFinite(recipeTime) ? recipeTime : 0);
  const defaultTriggerCount = isDummy ? 2 : 5;
  value.triggerCount = Math.max(1, Math.floor(Number(
    isDummy ? value.materialCount ?? value.triggerCount : value.triggerCount ?? value.lower
  ) || defaultTriggerCount));
  if (isDummy) value.materialCount = value.triggerCount;
  const dummyWaferCount = Number(value.dummyWaferCount);
  value.dummyWaferCount = isDummy ? Math.max(1, Math.floor(Number.isFinite(dummyWaferCount) ? dummyWaferCount : DEFAULT_DUMMY_WAFER_COUNT)) : 0;
  const wacRecipeTime = Number(value.wacRecipeTime ?? value.emptyRecipeTime);
  value.wacRecipeTime = Math.max(0, Number.isFinite(wacRecipeTime) ? wacRecipeTime : 20);
  value.modules = [...new Set(stringList(value.modules))];
  return value;
}
function formatCleanSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "\u672A\u8BBE\u7F6E";
  const text = Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${text}s`;
}
function automaticCleanName(clean) {
  const value = normalizeClean(clean);
  const labels = Object.fromEntries(CLEAN_TYPE_DEFINITIONS.map((item) => [item.key, item.label]));
  const mainDuration = formatCleanSeconds(value.recipeTime);
  if (value.cleanType === "dummywac") {
    return `${labels[value.cleanType]} \xB7 \u5355\u6B21 ${value.triggerCount}\u7247 \xB7 \u5E93\u5B58 ${value.dummyWaferCount}\u7247 \xB7 \u4E3B\u6E05\u6D01 ${mainDuration} \xB7 WAC ${formatCleanSeconds(value.wacRecipeTime)}`;
  }
  if (value.cleanType === "dummy") return `${labels[value.cleanType]} \xB7 \u5355\u6B21 ${value.triggerCount}\u7247 \xB7 \u5E93\u5B58 ${value.dummyWaferCount}\u7247 \xB7 ${mainDuration}`;
  return `${labels[value.cleanType]} \xB7 ${mainDuration}`;
}
function renameCleanReferences(oldName, newName) {
  if (!oldName || oldName === newName) return;
  const rename = (value) => stringList(value).map((name) => name === oldName ? newName : name);
  allTestRouteConfigs().forEach((config) => {
    ROUTE_CLEAN_KEYS.forEach((key) => {
      config[key] = rename(config[key]);
    });
    Object.values(config.stages || {}).forEach((stage) => {
      stage.beforeCleanRefs = rename(stage.beforeCleanRefs);
      stage.afterCleanRefs = rename(stage.afterCleanRefs);
    });
  });
}
function synchronizeCleanNames() {
  const occurrences = /* @__PURE__ */ new Map();
  let changed = false;
  state.cleans = state.cleans.map(normalizeClean);
  state.cleans.forEach((clean) => {
    const baseName = automaticCleanName(clean);
    const occurrence = (occurrences.get(baseName) || 0) + 1;
    occurrences.set(baseName, occurrence);
    const generatedName = occurrence === 1 ? baseName : `${baseName} \xB7 #${occurrence}`;
    const oldName = clean.name;
    if (oldName !== generatedName) {
      renameCleanReferences(oldName, generatedName);
      clean.name = generatedName;
      changed = true;
    }
    const recipeName = `${generatedName}-Recipe`;
    if (clean.recipeName !== recipeName) {
      clean.recipeName = recipeName;
      changed = true;
    }
  });
  return changed;
}
function runtimeClean(clean) {
  const value = normalizeClean(clean), type = value.cleanType;
  const taskNames = { preclean: "PreClean", postclean: "PostClean", wacclean: "WacClean", dummy: "PreDummyClean", dummywac: "PreWacClean" };
  const isWac = type === "wacclean", isDummy = type === "dummy" || type === "dummywac";
  return {
    ...value,
    recipeRef: value.recipeName,
    modules: value.modules,
    taskName: taskNames[type],
    stateVariable: isWac ? "ProcessCount" : "IdleTime",
    lower: isWac ? value.triggerCount : 0,
    upper: 9999,
    updateStateVariables: isWac ? ["ProcessCount"] : isDummy ? ["IdleTime", "DummyCount"] : type === "preclean" ? ["IdleTime"] : [],
    materialCount: isDummy ? value.triggerCount : 0,
    preJudge: false,
    emptyRecipeRef: type === "dummywac" ? `${value.recipeName}-WAC` : ""
  };
}
function makeClean(cleanType = "preclean") {
  const triggerCount = ["dummy", "dummywac"].includes(cleanType) ? 2 : 5;
  return normalizeClean({
    name: "",
    cleanType,
    recipeTime: 20,
    triggerCount,
    dummyWaferCount: DEFAULT_DUMMY_WAFER_COUNT,
    wacRecipeTime: 20,
    modules: []
  });
}
function stageUsesRobot(stage, index) {
  const names = (stage.visits || []).map((visit) => visit.stationName).filter(Boolean);
  return stage.kind === "robot" || (names.length ? names.every((name) => state.robotNames.includes(name)) : index % 2 === 1);
}
function isFixedRouteStep(route, index) {
  const stages = route?.stages || [];
  return index === 0 || index === stages.length - 1;
}
function stepKind(route, index) {
  if (!route?.stages?.length) return "Station";
  if (index === 0) return "Src";
  if (index === route.stages.length - 1) return "Sink";
  return stageUsesRobot(route.stages[index], index) ? "Robot" : "Station";
}
function normalizeRoute(route, normalizationChanges = null) {
  route.stages = Array.isArray(route.stages) ? route.stages : [];
  ROUTE_CLEAN_KEYS.forEach((key) => {
    route[key] = stringList(route[key]);
  });
  route.postCJobCleanRefs = [];
  route.bufferOption = Math.max(0, Math.min(4, Math.trunc(Number(route.bufferOption) || 0)));
  linkRouteSteps(route.stages);
  route.stages.forEach((stage, index) => {
    stage.visits = Array.isArray(stage.visits) ? stage.visits : [];
    stage.kind = stageUsesRobot(stage, index) ? "robot" : "station";
    stage.needProcess = stage.kind === "station" && stage.visits.some((visit) => state.processModules.includes(visit.stationName));
    const recipeName = stage.needProcess ? `${route.group || route.name || "Route"}_Step${stage.stepId}` : "";
    const recipesChanged = normalizeStageProcessRecipes(stage, recipeName, normalizeVisit);
    if (recipesChanged && normalizationChanges) normalizationChanges.changed = true;
  });
  return route;
}
function setStageCandidates(routeIndex, stageIndex, names) {
  const route = state.routes[routeIndex], stage = route.stages[stageIndex];
  replaceCandidates(stage, names, makeVisit, normalizeVisit);
  normalizeRoute(route);
}
function stageDefaultConfig(stage) {
  const first = (stage?.visits || [])[0] ? normalizeVisit(stage.visits[0]) : makeVisit("");
  return {
    processTime: Number(first.processTime),
    recipeTime: Number(first.recipeTime ?? first.processTime),
    qTimeLimit: Number(first.qTimeLimit),
    residencyConstraint: Number(first.residencyConstraint),
    beforeCleanRefs: structuredClone(stringList(first.beforeCleanRefs)),
    afterCleanRefs: structuredClone(stringList(first.afterCleanRefs)),
    processRecipe: String(first.processRecipe || ""),
    processType: String(first.processType || ""),
    weight: structuredClone(first.weight ?? {}),
    moveTimeOffset: structuredClone(first.moveTimeOffset ?? {}),
    slotIds: String(first.slotIds || "1")
  };
}
function defaultRouteConfigForRoute(route) {
  normalizeRoute(route);
  return {
    bufferOption: Math.max(0, Math.min(4, Math.trunc(Number(route.bufferOption) || 0))),
    prePJobCleanRefs: structuredClone(stringList(route.prePJobCleanRefs)),
    postPJobCleanRefs: structuredClone(stringList(route.postPJobCleanRefs)),
    postCJobCleanRefs: structuredClone(stringList(route.postCJobCleanRefs)),
    stages: Object.fromEntries((route.stages || []).map((stage) => [
      String(stage.stepId),
      stageDefaultConfig(stage)
    ]))
  };
}
function normalizeTestRouteConfigs(raw, routes) {
  const configs = raw && typeof raw === "object" && !Array.isArray(raw) ? structuredClone(raw) : {};
  const normalized = {};
  for (const route of routes || []) {
    const routeName = String(route.name || "").trim();
    if (!routeName) continue;
    const base = configs[routeName] || defaultRouteConfigForRoute(route);
    const stages = {};
    (route.stages || []).forEach((stage) => {
      const stepId = String(stage.stepId);
      const override = base.stages?.[stepId] ? base.stages[stepId] : stageDefaultConfig(stage);
      stages[stepId] = {
        ...stageDefaultConfig(stage),
        ...override && typeof override === "object" ? override : {},
        processTime: Number(override?.processTime ?? stageDefaultConfig(stage).processTime),
        recipeTime: Number(override?.processTime ?? stageDefaultConfig(stage).recipeTime),
        qTimeLimit: Number(override?.qTimeLimit ?? stageDefaultConfig(stage).qTimeLimit),
        residencyConstraint: Number(override?.residencyConstraint ?? stageDefaultConfig(stage).residencyConstraint),
        beforeCleanRefs: stringList(override?.beforeCleanRefs ?? stageDefaultConfig(stage).beforeCleanRefs),
        afterCleanRefs: stringList(override?.afterCleanRefs ?? stageDefaultConfig(stage).afterCleanRefs),
        processRecipe: String(override?.processRecipe ?? stageDefaultConfig(stage).processRecipe),
        processType: String(override?.processType ?? stageDefaultConfig(stage).processType),
        weight: structuredClone(override?.weight ?? stageDefaultConfig(stage).weight),
        moveTimeOffset: structuredClone(override?.moveTimeOffset ?? stageDefaultConfig(stage).moveTimeOffset),
        slotIds: String(override?.slotIds ?? stageDefaultConfig(stage).slotIds)
      };
    });
    normalized[routeName] = {
      bufferOption: Math.max(0, Math.min(4, Math.trunc(Number(base.bufferOption) || 0))),
      prePJobCleanRefs: stringList(base.prePJobCleanRefs),
      postPJobCleanRefs: stringList(base.postPJobCleanRefs),
      postCJobCleanRefs: stringList(base.postCJobCleanRefs),
      stages
    };
  }
  return normalized;
}
function pjobRouteConfig(pjob, route = null) {
  const template = route || state.routes.find((item) => item.name === pjob?.routeRef);
  if (!pjob || !template) return null;
  const fallback = state.testRouteConfigs[template.name] || defaultRouteConfigForRoute(template);
  const normalized = normalizeTestRouteConfigs(
    { [template.name]: pjob.routeConfig || fallback },
    [template]
  )[template.name];
  pjob.routeConfig = normalized;
  return normalized;
}
function allTestRouteConfigs() {
  const configs = [];
  state.rounds.forEach((round) => round.cjobs.forEach((cjob) => cjob.pjobs.forEach((pjob) => {
    const config = pjobRouteConfig(pjob);
    if (config) configs.push(config);
  })));
  return configs.length ? configs : Object.values(state.testRouteConfigs);
}
function normalizePJobRouteConfigs() {
  state.rounds.forEach((round) => round.cjobs.forEach((cjob) => cjob.pjobs.forEach((pjob) => {
    pjobRouteConfig(pjob);
  })));
}
function runtimeRouteForTemplate(route, routeConfig = null) {
  const routeName = String(route?.name || "").trim();
  const config = routeConfig || state.testRouteConfigs[routeName] || defaultRouteConfigForRoute(route);
  const merged = structuredClone(route);
  normalizeRoute(merged);
  merged.bufferOption = Number(config.bufferOption ?? merged.bufferOption ?? 0);
  merged.prePJobCleanRefs = stringList(config.prePJobCleanRefs);
  merged.postPJobCleanRefs = stringList(config.postPJobCleanRefs);
  merged.postCJobCleanRefs = stringList(config.postCJobCleanRefs);
  (merged.stages || []).forEach((stage) => {
    const stepId = String(stage.stepId);
    const override = config.stages?.[stepId];
    if (!override) return;
    (stage.visits || []).forEach((visit) => {
      visit.processTime = Number(override.processTime ?? visit.processTime ?? 20);
      visit.recipeTime = Number(override.recipeTime ?? visit.processTime ?? 20);
      visit.qTimeLimit = Number(override.qTimeLimit ?? visit.qTimeLimit ?? -1);
      visit.residencyConstraint = Number(override.residencyConstraint ?? visit.residencyConstraint ?? -1);
      visit.beforeCleanRefs = stringList(override.beforeCleanRefs ?? visit.beforeCleanRefs);
      visit.afterCleanRefs = stringList(override.afterCleanRefs ?? visit.afterCleanRefs);
      visit.processRecipe = String(override.processRecipe ?? visit.processRecipe ?? "");
      visit.processType = String(override.processType ?? visit.processType ?? "");
      visit.weight = structuredClone(override.weight ?? visit.weight ?? {});
      visit.moveTimeOffset = structuredClone(override.moveTimeOffset ?? visit.moveTimeOffset ?? {});
      visit.slotIds = String(override.slotIds ?? visit.slotIds ?? "1");
    });
    normalizeVisit(stage.visits[0]);
    synchronizeVisits(stage, normalizeVisit);
  });
  return merged;
}
function routeTemplateForSave(route) {
  const template = structuredClone(route);
  normalizeRoute(template);
  template.bufferOption = 0;
  ROUTE_CLEAN_KEYS.forEach((key) => {
    template[key] = [];
  });
  template.stages = (template.stages || []).map((stage) => ({
    stepId: Number(stage.stepId),
    postStepIds: structuredClone(stage.postStepIds || []),
    needProcess: stage.needProcess === true,
    kind: stage.kind,
    visits: (stage.visits || []).map((visit) => ({ stationName: String(visit.stationName || "") }))
  }));
  return template;
}
function captureRouteGroupingProfiles() {
  state.routeGroupingProfiles = new Map(
    state.routes.map((route) => [route, structuredClone(routeProcessProfile(route))])
  );
}
function routeGroupingProfile(route) {
  return state.routeGroupingProfiles.get(route) || routeProcessProfile(route);
}
function normalizeRounds() {
  let nextTaskId = 1;
  state.rounds = state.rounds.map((round, index) => {
    const normalized = normalizeRound(
      round,
      index + 1,
      state.times[index],
      nextTaskId,
      state.loadPorts
    );
    nextTaskId += normalized.cjobs.length;
    return normalized;
  });
  let nextMaterialId = 1;
  state.rounds.forEach((round) => round.cjobs.forEach((cjob) => cjob.pjobs.forEach((pjob) => {
    pjob.matList = Array.from({ length: pjob.waferCount }, () => nextMaterialId++);
  })));
  state.times = state.rounds.map((round) => Number(round.currentTime));
}
function escapeHtml3(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}
function readonlyText(value) {
  if (value === void 0 || value === null || value === "") return "\u2014";
  return typeof value === "string" ? value : JSON.stringify(value);
}
function renderReadonlyField(label, value, wide = false) {
  return `<div class="readonly-field ${wide ? "wide" : ""}"><span>${escapeHtml3(label)}</span><strong>${escapeHtml3(readonlyText(value))}</strong></div>`;
}
function unwrapDevice(raw) {
  let value = raw;
  if (Array.isArray(value)) {
    const entry = value.find((item) => item && String(item.Describe || "").toLowerCase() === "alginit");
    if (!entry) throw new Error("\u8BBE\u5907\u6587\u4EF6\u4E2D\u627E\u4E0D\u5230 Describe=AlgInit");
    value = entry.Info;
  }
  if (value?.InitData) value = value.InitData;
  if (value?.Info?.Stations) value = value.Info;
  if (!value || typeof value !== "object" || !value.Stations || !value.Robots) throw new Error("\u8BBE\u5907\u6587\u4EF6\u5FC5\u987B\u5305\u542B Stations \u548C Robots");
  return value;
}
function parseDeviceFileText(text) {
  try {
    return JSON.parse(text);
  } catch (originalError) {
    const records = text.trim().replace(/,\s*$/, "");
    try {
      return JSON.parse(`[${records}]`);
    } catch {
      throw originalError;
    }
  }
}
async function loadDevice(file) {
  if (!file) return;
  if (state.dirty) await saveCurrentTest(true);
  updateDataTransferProgress({ progress: 5, message: "\u6B63\u5728\u8BFB\u53D6 init JSON" });
  const fileText = await file.text();
  updateDataTransferProgress({ progress: 25, message: "\u6B63\u5728\u6821\u9A8C\u8BBE\u5907\u62D3\u6251" });
  const device = unwrapDevice(parseDeviceFileText(fileText));
  updateDataTransferProgress({ progress: 45, message: "\u6B63\u5728\u4FDD\u5B58\u8BBE\u5907" });
  const result = await requestJson("/api/workspaces/devices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name, device })
  });
  updateDataTransferProgress({ progress: 80, message: "\u6B63\u5728\u5237\u65B0\u8BBE\u5907\u4E0E\u6D4B\u8BD5\u96C6" });
  await loadWorkspaceCatalog(result.device.id);
  updateDataTransferProgress({ progress: 100, message: "\u8BBE\u5907\u5BFC\u5165\u5B8C\u6210" });
  writeTerminal(`$ ${result.created ? "\u5DF2\u5BFC\u5165" : "\u5DF2\u9009\u62E9\u5DF2\u6709"}\u8BBE\u5907 ${result.device.name}
  \u8BE5\u8BBE\u5907\u4E0B\u6709 ${state.workspaceDevice?.tests?.length || 0} \u4E2A\u6D4B\u8BD5\u96C6`);
  document.getElementById("deviceFile").value = "";
  document.getElementById("dataTransferDialog").close();
}
function openDataTransferDialog(mode) {
  dataTransferMode = mode;
  const importing = mode === "import";
  document.getElementById("dataTransferDialogTitle").textContent = importing ? "\u5BFC\u5165\u6570\u636E" : "\u5BFC\u51FA\u6570\u636E";
  document.getElementById("dataTransferDialogDescription").textContent = importing ? "\u9009\u62E9\u5BFC\u5165\u6574\u53F0\u8BBE\u5907\uFF0C\u6216\u628A\u6D4B\u8BD5\u96C6\u52A0\u5165\u5F53\u524D\u76F8\u540C\u8BBE\u5907\u3002" : "\u8BBE\u5907\u5305\u5305\u542B\u8BBE\u5907\u4E0B\u5168\u90E8\u4FE1\u606F\uFF1B\u6D4B\u8BD5\u96C6\u5305\u53EA\u5305\u542B\u5F53\u524D\u6D4B\u8BD5\u53CA\u6240\u9700\u8DEF\u5F84\u3002";
  document.getElementById("deviceTransferOptionTitle").textContent = importing ? "\u5BFC\u5165\u8BBE\u5907" : "\u5BFC\u51FA\u5F53\u524D\u8BBE\u5907";
  document.getElementById("deviceTransferOptionDescription").textContent = importing ? "\u652F\u6301\u540C\u4E8B\u5206\u4EAB\u7684\u8BBE\u5907\u5305\uFF0C\u4E5F\u652F\u6301\u65B0\u7684 init JSON\u3002" : "\u5305\u542B init\u3001\u8DEF\u5F84\u3001\u7EC4\u522B\u548C\u8BE5\u8BBE\u5907\u4E0B\u5168\u90E8\u6D4B\u8BD5\u96C6\u3002";
  document.getElementById("testTransferOptionTitle").textContent = importing ? "\u5BFC\u5165\u6D4B\u8BD5\u96C6" : "\u5BFC\u51FA\u5F53\u524D\u6D4B\u8BD5\u96C6";
  document.getElementById("testTransferOptionDescription").textContent = importing ? "\u53EA\u80FD\u5BFC\u5165\u5230 init \u5B8C\u5168\u76F8\u540C\u7684\u5F53\u524D\u8BBE\u5907\u3002" : "\u63A5\u6536\u65B9\u5FC5\u987B\u62E5\u6709 init \u5B8C\u5168\u76F8\u540C\u7684\u8BBE\u5907\u3002";
  document.getElementById("deviceTransferOption").disabled = !importing && !state.workspaceDeviceId;
  document.getElementById("testTransferOption").disabled = !state.workspaceDeviceId || !importing && !state.testCaseId;
  const status = document.getElementById("dataTransferStatus");
  status.textContent = importing && !state.workspaceDeviceId ? "\u5C1A\u672A\u9009\u62E9\u8BBE\u5907\u65F6\uFF0C\u53EA\u80FD\u5BFC\u5165\u8BBE\u5907\u3002" : "";
  status.classList.remove("error");
  resetDataTransferProgress();
  document.getElementById("dataTransferDialog").showModal();
}
function resetDataTransferProgress() {
  const progress = document.getElementById("dataTransferProgress");
  const bar = document.getElementById("dataTransferProgressBar");
  progress.hidden = true;
  bar.setAttribute("aria-valuenow", "0");
  bar.firstElementChild.style.width = "0%";
  document.getElementById("dataTransferPercent").textContent = "0%";
  document.getElementById("dataTransferPhase").textContent = "\u51C6\u5907\u4E2D";
  setDataTransferBusy(false);
}
function updateDataTransferProgress(transfer) {
  const progress = Math.max(0, Math.min(100, Number(transfer?.progress) || 0));
  const bar = document.getElementById("dataTransferProgressBar");
  document.getElementById("dataTransferProgress").hidden = false;
  bar.setAttribute("aria-valuenow", String(progress));
  bar.firstElementChild.style.width = `${progress}%`;
  document.getElementById("dataTransferPercent").textContent = `${progress}%`;
  document.getElementById("dataTransferPhase").textContent = String(transfer?.message || transfer?.phase || "\u5904\u7406\u4E2D");
}
function setDataTransferBusy(busy) {
  document.getElementById("deviceTransferOption").disabled = busy || dataTransferMode === "export" && !state.workspaceDeviceId;
  document.getElementById("testTransferOption").disabled = busy || !state.workspaceDeviceId || dataTransferMode === "export" && !state.testCaseId;
  document.getElementById("dataTransferDialogClose").disabled = busy;
  document.getElementById("dataTransferDialog").classList.toggle("is-busy", busy);
}
function uploadWorkspaceTransferContent(transferId, file) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/api/workspace-transfers/${encodeURIComponent(transferId)}/content`);
    request.setRequestHeader("Content-Type", "application/zip");
    request.setRequestHeader("X-Data-Filename", encodeURIComponent(file.name));
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) updateDataTransferProgress({ progress: Math.round(event.loaded / event.total * 20), message: "\u6B63\u5728\u4E0A\u4F20\u4EA4\u6362\u5305" });
    };
    request.onerror = () => reject(new Error("\u4EA4\u6362\u5305\u4E0A\u4F20\u5931\u8D25"));
    request.onload = () => {
      let result = {};
      try {
        result = JSON.parse(request.responseText || "{}");
      } catch {
      }
      if (request.status < 200 || request.status >= 300 || result?.ok === false) reject(new Error(result?.error || `\u670D\u52A1\u8FD4\u56DE ${request.status}`));
      else resolve();
    };
    request.send(file);
  });
}
async function runWorkspaceTransfer(kind, file) {
  if (dataTransferMode === "export") {
    if (!state.workspaceDeviceId) throw new Error("\u8BF7\u5148\u9009\u62E9\u8BBE\u5907");
    if (state.dirty) await saveCurrentTest(true);
    if (state.deviceTimingDirty) await saveDeviceTiming();
    if (kind === "test" && !state.testCaseId) throw new Error("\u8BF7\u5148\u9009\u62E9\u6D4B\u8BD5\u96C6");
  }
  const payload = {
    direction: dataTransferMode,
    kind,
    ...kind === "test" && state.workspaceDeviceId ? { deviceId: state.workspaceDeviceId } : {},
    ...dataTransferMode === "export" && kind === "device" && state.workspaceDeviceId ? { deviceId: state.workspaceDeviceId } : {},
    ...dataTransferMode === "export" && kind === "test" && state.testCaseId ? { testId: state.testCaseId } : {}
  };
  const created = await requestJson("/api/workspace-transfers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const transferId = created.transfer?.id;
  if (!transferId) throw new Error("\u670D\u52A1\u672A\u8FD4\u56DE\u4EA4\u6362\u4EFB\u52A1\u7F16\u53F7");
  updateDataTransferProgress(created.transfer);
  if (dataTransferMode === "import") {
    if (!file) throw new Error("\u8BF7\u9009\u62E9\u4EA4\u6362\u6587\u4EF6");
    await uploadWorkspaceTransferContent(String(transferId), file);
  }
  let transfer = created.transfer;
  while (!["completed", "failed"].includes(String(transfer.status))) {
    await new Promise((resolve) => window.setTimeout(resolve, WORKSPACE_TRANSFER_POLL_MILLISECONDS));
    transfer = (await requestJson(`/api/workspace-transfers/${encodeURIComponent(String(transferId))}`, { cache: "no-store" })).transfer;
    updateDataTransferProgress(transfer);
  }
  if (transfer.status === "failed") throw new Error(transfer.message || "\u4EA4\u6362\u4EFB\u52A1\u5931\u8D25");
  if (dataTransferMode === "export") {
    updateDataTransferProgress({ ...transfer, message: "\u6B63\u5728\u4E0B\u8F7D\u4EA4\u6362\u5305" });
    await downloadWorkspaceArchive(`/api/workspace-transfers/${encodeURIComponent(String(transferId))}/download`);
    document.getElementById("dataTransferDialog").close();
    setWorkspaceStatus(kind === "device" ? "\u5DF2\u5BFC\u51FA\u5F53\u524D\u8BBE\u5907" : "\u5DF2\u5BFC\u51FA\u5F53\u524D\u6D4B\u8BD5\u96C6", "saved");
  } else {
    const result = transfer.result || {};
    if (kind === "device" && result.device?.id) {
      await loadWorkspaceCatalog(result.device.id);
      setWorkspaceStatus(`\u5DF2\u5BFC\u5165\u8BBE\u5907\u201C${result.device.name}\u201D\u53CA ${result.importedTests || 0} \u4E2A\u6D4B\u8BD5\u96C6`, "saved");
    } else if (kind === "test" && result.test?.id) {
      await loadWorkspaceCatalog(state.workspaceDeviceId, result.test.id);
      setWorkspaceStatus(result.created ? `\u5DF2\u5BFC\u5165\u6D4B\u8BD5\u96C6\u201C${result.test.name}\u201D` : `\u6D4B\u8BD5\u96C6\u201C${result.test.name}\u201D\u5DF2\u5B58\u5728`, "saved");
    }
    document.getElementById("dataTransferDialog").close();
  }
}
async function downloadWorkspaceArchive(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result?.error || `\u670D\u52A1\u8FD4\u56DE ${response.status}`);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") || "";
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] || "ct-data.zip";
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}
async function chooseDataTransfer(kind) {
  const status = document.getElementById("dataTransferStatus");
  status.textContent = "";
  status.classList.remove("error");
  try {
    if (dataTransferMode === "export") {
      setDataTransferBusy(true);
      await runWorkspaceTransfer(kind);
      return;
    }
    if (kind === "test" && !state.workspaceDeviceId) throw new Error("\u8BF7\u5148\u9009\u62E9\u6D4B\u8BD5\u96C6\u6240\u5C5E\u7684\u76F8\u540C\u8BBE\u5907");
    document.getElementById(kind === "device" ? "deviceFile" : "testExchangeFile").click();
  } catch (error) {
    status.textContent = error.message || "\u64CD\u4F5C\u5931\u8D25";
    status.classList.add("error");
    setDataTransferBusy(false);
  }
}
function robotAvailableSlots(robot) {
  const slots = /* @__PURE__ */ new Set();
  const addSlots = (rawSlots, scalarIsCapacity = false) => {
    let values3 = [];
    if (Number.isInteger(rawSlots) && typeof rawSlots !== "boolean") {
      values3 = scalarIsCapacity ? Array.from({ length: Math.max(0, rawSlots) }, (_, index) => index + FIRST_ROBOT_SLOT_ID) : [rawSlots];
    } else if (Array.isArray(rawSlots)) values3 = rawSlots;
    else if (rawSlots && typeof rawSlots === "object") values3 = Object.keys(rawSlots);
    values3.forEach((value) => {
      const slotId = Number(value);
      if (Number.isInteger(slotId) && slotId >= FIRST_ROBOT_SLOT_ID) slots.add(slotId);
    });
  };
  Object.values(robot?.ArmInfo || {}).forEach((arm) => addSlots(arm?.SlotIDs));
  if (Object.values(robot?.ArmInfo || {}).some((arm) => arm && typeof arm === "object")) {
    for (let slotId = FIRST_ROBOT_SLOT_ID; slotId < FIRST_ROBOT_SLOT_ID + DUAL_ARM_SLOT_COUNT; slotId += 1) slots.add(slotId);
  }
  addSlots(robot?.Capacity, true);
  return [...slots.size ? slots : /* @__PURE__ */ new Set([FIRST_ROBOT_SLOT_ID])].sort((left, right) => left - right);
}
function robotArmSlotGroups(robot) {
  const declaredGroups = Object.entries(robot?.ArmInfo || {}).flatMap(([armName, arm]) => {
    if (!arm || typeof arm !== "object") return [];
    const slotIds = [...new Set((arm.SlotIDs || []).map(Number).filter(
      (slotId) => Number.isInteger(slotId) && slotId >= FIRST_ROBOT_SLOT_ID
    ))].sort((left, right) => left - right);
    return slotIds.length ? [{ armName, slotIds }] : [];
  });
  const groups = declaredGroups.length ? declaredGroups : [];
  const coveredSlots = new Set(groups.flatMap((group) => group.slotIds));
  robotAvailableSlots(robot).filter((slotId) => !coveredSlots.has(slotId)).forEach((slotId) => {
    groups.push({
      armName: generatedRobotArmName(groups.map((group) => group.armName), slotId),
      slotIds: [slotId]
    });
  });
  return groups;
}
function robotDefaultSlots(robot) {
  const available = robotAvailableSlots(robot);
  const requested = Object.values(robot?.ArmInfo || {}).filter((arm) => arm && typeof arm === "object" && arm.IsEnable !== false).flatMap((arm) => Array.isArray(arm.SlotIDs) ? arm.SlotIDs.map(Number) : []);
  const selected = [...new Set(requested.filter((slotId) => Number.isInteger(slotId) && available.includes(slotId)))].sort((left, right) => left - right);
  return selected.length ? selected : available.slice(0, 1);
}
function normalizeRobotSlotSelections(device, rawSelections = {}) {
  const selections = rawSelections && typeof rawSelections === "object" ? rawSelections : {};
  return Object.fromEntries(Object.entries(device?.Robots || {}).map(([robotName, robot]) => {
    const available = robotAvailableSlots(robot);
    const requested = Array.isArray(selections[robotName]) ? selections[robotName].map(Number) : robotDefaultSlots(robot);
    const selected = [...new Set(requested.filter((slotId) => Number.isInteger(slotId) && available.includes(slotId)))].sort((left, right) => left - right);
    return [robotName, selected.length ? selected : available];
  }));
}
function generatedRobotArmName(existingNames, slotId) {
  const occupied = new Set(existingNames.map(String));
  const alphabeticName = `Arm${String.fromCharCode("A".charCodeAt(0) + slotId - FIRST_ROBOT_SLOT_ID)}`;
  if (!occupied.has(alphabeticName)) return alphabeticName;
  const numericName = `Arm${slotId}`;
  if (!occupied.has(numericName)) return numericName;
  let suffix = slotId;
  while (occupied.has(`${numericName}_${suffix}`)) suffix += 1;
  return `${numericName}_${suffix}`;
}
function projectRobotArmToSlots(armName, sourceArm, slotIds) {
  const arm = structuredClone(sourceArm);
  arm.Name = armName;
  arm.IsEnable = true;
  const selected = [...new Set(slotIds.map(Number))].sort((left, right) => left - right);
  arm.SlotIDs = selected;
  Object.entries(arm.SlotsStationMap || {}).forEach(([stationName, stationSlots]) => {
    if (!stationSlots || typeof stationSlots !== "object") return;
    const entries = Object.entries(stationSlots);
    if (!entries.length) return;
    const fallback = entries[0][1];
    arm.SlotsStationMap[stationName] = Object.fromEntries(selected.map((slotId) => [
      String(slotId),
      structuredClone(stationSlots[String(slotId)] ?? fallback)
    ]));
  });
  return arm;
}
function configuredDeviceForRobotSlots(baseDevice, rawSelections) {
  const device = structuredClone(baseDevice);
  const selections = normalizeRobotSlotSelections(device, rawSelections);
  Object.entries(device?.Robots || {}).forEach(([robotName, robot]) => {
    const selected = selections[robotName];
    robot.Capacity = selected.length;
    const sourceArms = Object.entries(robot.ArmInfo || {}).filter(([, arm]) => arm && typeof arm === "object");
    if (!sourceArms.length) return;
    const projectedArms = {}, unmatchedSlots = new Set(selected);
    sourceArms.forEach(([armName, sourceArm]) => {
      const retainedSlots = (sourceArm.SlotIDs || []).map(Number).filter((slotId) => unmatchedSlots.has(slotId));
      if (!retainedSlots.length) return;
      projectedArms[armName] = projectRobotArmToSlots(armName, sourceArm, retainedSlots);
      retainedSlots.forEach((slotId) => unmatchedSlots.delete(slotId));
    });
    [...unmatchedSlots].sort((left, right) => left - right).forEach((slotId) => {
      const armName = generatedRobotArmName(
        [...Object.keys(robot.ArmInfo || {}), ...Object.keys(projectedArms)],
        slotId
      );
      projectedArms[armName] = projectRobotArmToSlots(armName, sourceArms[0][1], [slotId]);
    });
    robot.ArmInfo = projectedArms;
  });
  return { device, selections };
}
function applyDeviceTopology(device, deviceName, rawRobotSlots = {}) {
  state.baseDevice = structuredClone(device);
  const configured = configuredDeviceForRobotSlots(state.baseDevice, rawRobotSlots);
  state.device = configured.device;
  state.robotSlots = configured.selections;
  const stations = Object.entries(state.device.Stations);
  const natural = (left, right) => left.localeCompare(right, void 0, { numeric: true });
  state.deviceName = deviceName;
  state.stationNames = stations.map(([name]) => name).sort(natural);
  state.loadPorts = stations.filter(([, item]) => String(item.Type || "").toLowerCase() === "loadport").map(([name]) => name).sort(natural);
  state.processModules = stations.filter(([, item]) => PROCESSING_STATION_TYPES.has(String(item.Type || "").trim().toLowerCase())).map(([name]) => name).sort(natural);
  state.robotNames = Object.keys(state.device.Robots).sort(natural);
  state.robotScopes = Object.fromEntries(Object.entries(state.device.Robots).map(([name, robot]) => [name, [...new Set(Object.values(robot.ArmInfo || {}).filter((arm) => arm.IsEnable !== false).flatMap((arm) => arm.AccessibleStations || []))]]));
  visualizationWorkspace.setDevice(state.device);
  if (!state.loadPorts.length || !state.processModules.length) throw new Error("\u8BBE\u5907\u5FC5\u987B\u5305\u542B LoadPort \u548C ProcessChamber");
}
function buildDeviceTimingDraft(device) {
  const draft = { stations: {}, robots: {} };
  Object.entries(device?.Stations || {}).forEach(([stationName, station2]) => {
    const timing = {};
    [...STATION_ACTION_TIME_FIELDS, { key: "AlignmentTime" }].forEach(({ key }) => {
      if (station2?.[key] && typeof station2[key] === "object" && !Array.isArray(station2[key])) {
        timing[key] = structuredClone(station2[key]);
      }
    });
    if (Array.isArray(station2?.PrePrepareTime)) {
      timing.PrePrepareTime = station2.PrePrepareTime.map((row) => Number(row?.Time) || 0);
    }
    draft.stations[stationName] = timing;
  });
  Object.entries(device?.Robots || {}).forEach(([robotName, robot]) => {
    const timing = {};
    ROBOT_ACTION_TIME_FIELDS.forEach(({ key }) => {
      if (robot?.[key] && typeof robot[key] === "object" && !Array.isArray(robot[key])) {
        timing[key] = structuredClone(robot[key]);
      }
    });
    if (Array.isArray(robot?.PrepTransTime)) {
      timing.PrepTransTime = robot.PrepTransTime.map((row) => Number(row?.Time) || 0);
    }
    draft.robots[robotName] = timing;
  });
  const configuredExecution = device?.ExecutionTiming && typeof device.ExecutionTiming === "object" ? device.ExecutionTiming : {};
  const overlayTiming = (defaults, configured) => Object.fromEntries(Object.entries(defaults).map(([itemName, fields]) => [
    itemName,
    Object.fromEntries(Object.entries(fields).map(([fieldName, values3]) => {
      const configuredValues = configured?.[itemName]?.[fieldName];
      if (Array.isArray(values3)) {
        return [fieldName, values3.map((value, index) => Number.isFinite(Number(configuredValues?.[index])) ? Number(configuredValues[index]) : value)];
      }
      return [fieldName, Object.fromEntries(Object.entries(values3).map(([key, value]) => [
        key,
        Number.isFinite(Number(configuredValues?.[key])) ? Number(configuredValues[key]) : value
      ]))];
    }))
  ]));
  const rawFluctuation = configuredExecution.fluctuation || {};
  draft.execution = {
    mode: configuredExecution.mode === "fluctuation" ? "fluctuation" : "fixed",
    fluctuation: {
      kind: rawFluctuation.kind === "offset" ? "offset" : "ratio",
      ratio: Math.max(0, Math.min(1, Number(rawFluctuation.ratio) || 0)),
      minimumOffsetSeconds: Number.isFinite(Number(rawFluctuation.minimumOffsetSeconds)) ? Number(rawFluctuation.minimumOffsetSeconds) : 0,
      maximumOffsetSeconds: Number.isFinite(Number(rawFluctuation.maximumOffsetSeconds)) ? Number(rawFluctuation.maximumOffsetSeconds) : 0
    },
    stations: overlayTiming(draft.stations, configuredExecution.stations),
    robots: overlayTiming(draft.robots, configuredExecution.robots)
  };
  return draft;
}
function configuredExecutionTime(dataset) {
  const section = dataset["device-timing-target"]?.startsWith("station") ? "stations" : "robots";
  const fields = state.deviceTimingDraft?.execution?.[section]?.[dataset["device-name"]];
  if (!fields) return 0;
  return dataset["device-timing-target"]?.endsWith("map") ? fields[dataset["timing-field"]]?.[dataset["timing-key"]] ?? 0 : fields[dataset["timing-field"]]?.[Number(dataset["timing-index"])] ?? 0;
}
function deviceTimeInput(value, label, dataset) {
  const attributes = Object.entries(dataset).map(([name, item]) => `data-${name}="${escapeHtml3(item)}"`).join(" ");
  const numericValue = Number(value);
  const executionValue = Number(configuredExecutionTime(dataset));
  const executionDisabled = state.deviceTimingDraft?.execution?.mode === "fluctuation" ? " disabled" : "";
  const executionAttributes = attributes.replaceAll("data-device-timing-target", "data-device-execution-target");
  return `<span class="device-time-pair"><label><small>\u7406\u8BBA</small><span class="device-time-input"><input type="number" min="0" step="any" inputmode="decimal" required value="${Number.isFinite(numericValue) ? numericValue : 0}" aria-label="${escapeHtml3(label)}\uFF08\u7406\u8BBA\uFF09" ${attributes}><span>s</span></span></label><label><small>\u6267\u884C</small><span class="device-time-input"><input type="number" min="0" step="any" inputmode="decimal" required value="${Number.isFinite(executionValue) ? executionValue : 0}" aria-label="${escapeHtml3(label)}\uFF08\u56FA\u5B9A\u6267\u884C\uFF09" ${executionAttributes}${executionDisabled}><span>s</span></span></label></span>`;
}
function renderExecutionTimingConfiguration() {
  const container = document.getElementById("deviceExecutionTimingEditor");
  const execution = state.deviceTimingDraft?.execution;
  if (!container || !execution) {
    if (container) container.innerHTML = `<div class="device-config-empty"><strong>\u6682\u65E0\u6267\u884C\u65F6\u95F4\u914D\u7F6E</strong><span>\u8BF7\u5148\u9009\u62E9\u8BBE\u5907\u3002</span></div>`;
    return;
  }
  const fluctuating = execution.mode === "fluctuation";
  const offset = execution.fluctuation.kind === "offset";
  container.innerHTML = `
    <section class="execution-timing-card">
      <header><div><h3>\u5B9E\u9645\u52A8\u4F5C\u65F6\u957F</h3><p>\u7B97\u6CD5\u59CB\u7EC8\u4F7F\u7528\u7406\u8BBA\u65F6\u95F4\uFF1B\u5E73\u53F0\u72B6\u6001\u673A\u53EA\u5728\u8FD0\u884C\u8BBE\u7F6E\u542F\u7528\u540E\u5E94\u7528\u8FD9\u91CC\u7684\u6267\u884C\u65F6\u95F4\u3002</p></div></header>
      <div class="execution-mode-grid" role="radiogroup" aria-label="\u6267\u884C\u65F6\u95F4\u6A21\u5F0F">
        <label class="run-setting-option"><span class="run-setting-option-main"><input type="radio" name="executionTimingMode" value="fixed" ${fluctuating ? "" : "checked"}><span>\u56FA\u5B9A\u6267\u884C\u503C</span></span><small>\u4F7F\u7528\u8BBE\u5907\u65F6\u95F4\u548C\u673A\u5668\u624B\u65F6\u95F4\u8868\u4E2D\u5E76\u5217\u7684\u201C\u6267\u884C\u201D\u503C\u3002</small></label>
        <label class="run-setting-option"><span class="run-setting-option-main"><input type="radio" name="executionTimingMode" value="fluctuation" ${fluctuating ? "checked" : ""}><span>\u7406\u8BBA\u503C\u968F\u673A\u6CE2\u52A8</span></span><small>\u4EE5\u6BCF\u4E2A Move \u7684\u7406\u8BBA\u65F6\u957F\u4E3A\u5747\u503C\uFF0C\u6309 seed \u751F\u6210\u53EF\u590D\u73B0\u6837\u672C\u3002</small></label>
      </div>
      <div class="execution-fluctuation-fields" ${fluctuating ? "" : "hidden"}>
        <label class="field"><span>\u6CE2\u52A8\u65B9\u5F0F</span><select id="executionFluctuationKind"><option value="ratio" ${offset ? "" : "selected"}>\u6BD4\u4F8B\uFF08\xB1\uFF09</option><option value="offset" ${offset ? "selected" : ""}>\u6700\u5C0F/\u6700\u5927\u504F\u79FB</option></select></label>
        <label class="field" ${offset ? "hidden" : ""}><span>\u6CE2\u52A8\u6BD4\u4F8B</span><input id="executionFluctuationRatio" type="number" min="0" max="100" step="0.1" value="${(execution.fluctuation.ratio * 100).toFixed(1)}"><small>\u4F8B\u5982 10 \u8868\u793A\u7406\u8BBA\u65F6\u957F\u7684 \xB110%\u3002</small></label>
        <label class="field" ${offset ? "" : "hidden"}><span>\u6700\u5C0F\u6CE2\u52A8\uFF08\u79D2\uFF09</span><input id="executionMinimumOffset" type="number" step="any" value="${execution.fluctuation.minimumOffsetSeconds}"></label>
        <label class="field" ${offset ? "" : "hidden"}><span>\u6700\u5927\u6CE2\u52A8\uFF08\u79D2\uFF09</span><input id="executionMaximumOffset" type="number" step="any" value="${execution.fluctuation.maximumOffsetSeconds}"></label>
      </div>
      <div class="device-time-inline-empty">\u56FA\u5B9A\u6A21\u5F0F\u7684\u5177\u4F53\u6267\u884C\u503C\u4F4D\u4E8E\u201C\u8BBE\u5907\u65F6\u95F4\u201D\u548C\u201C\u673A\u5668\u624B\u65F6\u95F4\u201D\u8868\u683C\uFF0C\u6BCF\u4E2A\u7406\u8BBA\u503C\u53F3\u4FA7\u5747\u6709\u5BF9\u5E94\u6267\u884C\u503C\u3002</div>
    </section>`;
}
function renderDeviceConfigHeader() {
  const hasDevice = Boolean(state.workspaceDeviceId && state.baseDevice);
  document.getElementById("deviceConfigSelectedName").textContent = hasDevice ? displayDeviceName(state.deviceName) : "\u5C1A\u672A\u9009\u62E9\u8BBE\u5907";
  const status = document.getElementById("deviceTimingStatus");
  status.textContent = state.deviceTimingSaving ? "\u6B63\u5728\u4FDD\u5B58\u65F6\u95F4\u53C2\u6570\u2026" : state.deviceTimingDirty ? "\u6709\u5C1A\u672A\u4FDD\u5B58\u7684\u65F6\u95F4\u4FEE\u6539" : state.deviceTimingStatusMessage;
  status.classList.toggle("is-dirty", state.deviceTimingDirty);
  status.classList.toggle("is-saving", state.deviceTimingSaving);
  document.getElementById("resetDeviceTimingButton").disabled = !hasDevice || !state.deviceTimingDirty || state.deviceTimingSaving;
  document.getElementById("saveDeviceTimingButton").disabled = !hasDevice || !state.deviceTimingDirty || state.deviceTimingSaving;
}
function renderDeviceTimingSelectors() {
  const stationSelect = document.getElementById("deviceStationSelect");
  const robotSelect = document.getElementById("deviceRobotSelect");
  if (!state.stationNames.includes(state.deviceStationName)) state.deviceStationName = state.stationNames[0] || "";
  if (!state.robotNames.includes(state.deviceRobotName)) state.deviceRobotName = state.robotNames[0] || "";
  stationSelect.innerHTML = state.stationNames.length ? state.stationNames.map((name) => `<option value="${escapeHtml3(name)}" ${name === state.deviceStationName ? "selected" : ""}>${escapeHtml3(name)}</option>`).join("") : `<option value="">\u8BF7\u5148\u9009\u62E9\u8BBE\u5907</option>`;
  robotSelect.innerHTML = state.robotNames.length ? state.robotNames.map((name) => `<option value="${escapeHtml3(name)}" ${name === state.deviceRobotName ? "selected" : ""}>${escapeHtml3(name)}</option>`).join("") : `<option value="">\u8BF7\u5148\u9009\u62E9\u8BBE\u5907</option>`;
  stationSelect.disabled = !state.stationNames.length;
  robotSelect.disabled = !state.robotNames.length;
  const stationIndex = state.stationNames.indexOf(state.deviceStationName);
  const robotIndex = state.robotNames.indexOf(state.deviceRobotName);
  document.getElementById("previousDeviceStationButton").disabled = stationIndex <= 0;
  document.getElementById("nextDeviceStationButton").disabled = stationIndex < 0 || stationIndex >= state.stationNames.length - 1;
  document.getElementById("previousDeviceRobotButton").disabled = robotIndex <= 0;
  document.getElementById("nextDeviceRobotButton").disabled = robotIndex < 0 || robotIndex >= state.robotNames.length - 1;
}
function stepDeviceTimingSelection(kind, offset) {
  const stationSelection = kind === "station";
  const names = stationSelection ? state.stationNames : state.robotNames;
  const currentName = stationSelection ? state.deviceStationName : state.deviceRobotName;
  const nextIndex = names.indexOf(currentName) + offset;
  if (nextIndex < 0 || nextIndex >= names.length) return;
  if (stationSelection) {
    state.deviceStationName = names[nextIndex];
    renderDeviceTimingConfiguration();
    return;
  }
  state.deviceRobotName = names[nextIndex];
  renderDeviceTimingConfiguration();
}
function renderDeviceStationTiming() {
  const container = document.getElementById("deviceStationTimingEditor");
  const stationName = state.deviceStationName;
  const station2 = state.baseDevice?.Stations?.[stationName];
  const timing = state.deviceTimingDraft?.stations?.[stationName];
  if (!station2 || !timing) {
    container.innerHTML = `<div class="device-config-empty"><strong>\u6682\u65E0\u53EF\u914D\u7F6E\u7AD9\u70B9</strong><span>\u9009\u62E9\u6216\u5BFC\u5165\u8BBE\u5907\u540E\uFF0C\u53EF\u5728\u8FD9\u91CC\u6821\u51C6\u7AD9\u70B9\u52A8\u4F5C\u65F6\u95F4\u3002</span></div>`;
    return;
  }
  const actionControllers = [...new Set(STATION_ACTION_TIME_FIELDS.flatMap(
    ({ key }) => Object.keys(timing[key] || {})
  ))].sort((left, right) => left.localeCompare(right, void 0, { numeric: true }));
  const actionRows = actionControllers.map((controller) => `
    <tr>
      <th scope="row"><strong>${escapeHtml3(controller)}</strong></th>
      ${STATION_ACTION_TIME_FIELDS.map(({ key, label }) => {
    if (!Object.prototype.hasOwnProperty.call(timing[key] || {}, controller)) return `<td><span class="device-time-unavailable">\u2014</span></td>`;
    return `<td>${deviceTimeInput(timing[key][controller], `${stationName} ${controller} ${label}`, {
      "device-timing-target": "station-map",
      "device-name": stationName,
      "timing-field": key,
      "timing-key": controller
    })}</td>`;
  }).join("")}
    </tr>
  `).join("");
  const alignmentEntries = Object.entries(timing.AlignmentTime || {});
  const prePrepareRows = Array.isArray(station2.PrePrepareTime) ? station2.PrePrepareTime : [];
  const specialRows = [
    ...alignmentEntries.map(([slotId, value]) => `
      <div class="device-transition-row">
        <span class="device-transition-kind">AlignmentTime</span>
        <strong>Slot ${escapeHtml3(slotId)}</strong>
        <span class="device-transition-route">key=${escapeHtml3(slotId)}</span>
        ${deviceTimeInput(value, `${stationName} Slot ${slotId} \u5BF9\u51C6\u65F6\u95F4`, {
      "device-timing-target": "station-map",
      "device-name": stationName,
      "timing-field": "AlignmentTime",
      "timing-key": slotId
    })}
      </div>
    `),
    ...prePrepareRows.map((row, index) => `
      <div class="device-transition-row">
        <span class="device-transition-kind">PrePrepareTime</span>
        <strong>${escapeHtml3(row?.LastItem || "\u2014")} <i aria-hidden="true">\u2192</i> ${escapeHtml3(row?.CurrentItem || "\u2014")}</strong>
        <span class="device-transition-route">${escapeHtml3(row?.PrePrepareType || "PrePrepareType")}</span>
        ${deviceTimeInput(timing.PrePrepareTime?.[index] ?? row?.Time ?? 0, `${stationName} ${row?.PrePrepareType || "\u72B6\u6001\u5207\u6362"}`, {
      "device-timing-target": "station-sequence",
      "device-name": stationName,
      "timing-field": "PrePrepareTime",
      "timing-index": index
    })}
      </div>
    `)
  ];
  container.innerHTML = `
    <section class="device-time-section" aria-labelledby="stationActionTimingTitle">
      <header><h3 id="stationActionTimingTitle">Station action fields</h3></header>
      ${actionRows ? `<div class="device-time-table-wrap"><table class="device-time-table"><thead><tr><th>Robot</th>${STATION_ACTION_TIME_FIELDS.map(({ label }) => `<th><code>${label}</code></th>`).join("")}</tr></thead><tbody>${actionRows}</tbody></table></div>` : `<div class="device-time-inline-empty">\u65E0\u53EF\u7F16\u8F91\u5B57\u6BB5</div>`}
    </section>
    <section class="device-time-section" aria-labelledby="stationTransitionTimingTitle">
      <header><h3 id="stationTransitionTimingTitle">Station-specific fields</h3></header>
      ${specialRows.length ? `<div class="device-transition-list">${specialRows.join("")}</div>` : `<div class="device-time-inline-empty">\u65E0\u53EF\u7F16\u8F91\u5B57\u6BB5</div>`}
    </section>`;
}
function renderDeviceRobotTiming() {
  const container = document.getElementById("deviceRobotTimingEditor");
  const robotName = state.deviceRobotName;
  const robot = state.baseDevice?.Robots?.[robotName];
  const timing = state.deviceTimingDraft?.robots?.[robotName];
  if (!robot || !timing) {
    container.innerHTML = `<div class="device-config-empty"><strong>\u6682\u65E0\u53EF\u914D\u7F6E\u673A\u5668\u624B</strong><span>\u5F53\u524D\u8BBE\u5907\u6CA1\u6709\u58F0\u660E\u673A\u5668\u624B\u65F6\u95F4\u53C2\u6570\u3002</span></div>`;
    return;
  }
  const actionStations = [...new Set(ROBOT_ACTION_TIME_FIELDS.flatMap(
    ({ key }) => Object.keys(timing[key] || {})
  ))].sort((left, right) => left.localeCompare(right, void 0, { numeric: true }));
  const actionRows = actionStations.map((stationName) => `
    <tr><th scope="row"><strong>${escapeHtml3(stationName)}</strong></th>${ROBOT_ACTION_TIME_FIELDS.map(({ key, label }) => {
    if (!Object.prototype.hasOwnProperty.call(timing[key] || {}, stationName)) return `<td><span class="device-time-unavailable">\u2014</span></td>`;
    return `<td>${deviceTimeInput(timing[key][stationName], `${robotName} \u5728 ${stationName} \u7684${label}\u65F6\u95F4`, {
      "device-timing-target": "robot-map",
      "device-name": robotName,
      "timing-field": key,
      "timing-key": stationName
    })}</td>`;
  }).join("")}</tr>
  `).join("");
  const transferRows = Array.isArray(robot.PrepTransTime) ? robot.PrepTransTime : [];
  const selectedAxis = state.deviceRobotTransferAxes[robotName] === "dest" ? "dest" : "src";
  const selectedField = selectedAxis === "src" ? "SrcStation" : "DestStation";
  const counterpartField = selectedAxis === "src" ? "DestStation" : "SrcStation";
  const selectableStations = [...new Set(transferRows.map((row) => String(row?.[selectedField] || "")).filter(Boolean))].sort((left, right) => left.localeCompare(right, void 0, { numeric: true }));
  const selectionKey = `${robotName}:${selectedAxis}`;
  let selectedStation = state.deviceRobotTransferSources[selectionKey];
  if (!selectableStations.includes(selectedStation)) selectedStation = selectableStations[0] || "";
  state.deviceRobotTransferSources[selectionKey] = selectedStation;
  const visibleTransfers = transferRows.map((row, index) => ({ row, index })).filter(({ row }) => String(row?.[selectedField] || "") === selectedStation);
  const transfersByCounterpart = /* @__PURE__ */ new Map();
  visibleTransfers.forEach((item) => {
    const counterpart = String(item.row?.[counterpartField] || "");
    if (!transfersByCounterpart.has(counterpart)) transfersByCounterpart.set(counterpart, { 0: [], 1: [] });
    const type = Number(item.row?.TransType) === 1 ? 1 : 0;
    transfersByCounterpart.get(counterpart)[type].push(item);
  });
  const transferMatrixRows = [...transfersByCounterpart.entries()].sort(([left], [right]) => left.localeCompare(right, void 0, { numeric: true })).map(([destination, byType]) => `
      <tr>
        <th scope="row"><strong>${escapeHtml3(destination || "\u2014")}</strong></th>
        ${[0, 1].map((type) => {
    const entries = byType[type];
    if (!entries.length) return `<td><span class="device-time-unavailable">\u2014</span></td>`;
    return `<td>${entries.map(({ row, index }) => deviceTimeInput(
      timing.PrepTransTime?.[index] ?? row?.Time ?? 0,
      `${robotName} ${row?.SrcStation || "\u2014"} \u2192 ${row?.DestStation || "\u2014"} ${type === 1 ? "OnLoad" : "NoLoad"} Time`,
      {
        "device-timing-target": "robot-sequence",
        "device-name": robotName,
        "timing-field": "PrepTransTime",
        "timing-index": index
      }
    )).join("")}</td>`;
  }).join("")}
      </tr>
    `).join("");
  container.innerHTML = `
    <section class="device-time-section robot-action-section" aria-labelledby="robotActionTimingTitle">
      <header><h3 id="robotActionTimingTitle">Robot action fields</h3></header>
      ${actionRows ? `<div class="device-time-table-wrap"><table class="device-time-table compact"><thead><tr><th>Station</th>${ROBOT_ACTION_TIME_FIELDS.map(({ label }) => `<th><code>${label}</code></th>`).join("")}</tr></thead><tbody>${actionRows}</tbody></table></div>` : `<div class="device-time-inline-empty">\u65E0\u53EF\u7F16\u8F91\u5B57\u6BB5</div>`}
    </section>
    <section class="device-time-section" aria-labelledby="robotTransferTimingTitle">
      <header class="device-transfer-head">
        <h3 id="robotTransferTimingTitle">PrepTransTime</h3>
        <div class="device-transfer-filters">
          <label><span>Field</span><select data-robot-transfer-axis="${escapeHtml3(robotName)}"><option value="src" ${selectedAxis === "src" ? "selected" : ""}>SrcStation</option><option value="dest" ${selectedAxis === "dest" ? "selected" : ""}>DestStation</option></select></label>
          <label><span>Station</span><select data-robot-transfer-station="${escapeHtml3(robotName)}" ${selectableStations.length ? "" : "disabled"}>${selectableStations.length ? selectableStations.map((stationName) => `<option value="${escapeHtml3(stationName)}" ${stationName === selectedStation ? "selected" : ""}>${escapeHtml3(stationName)}</option>`).join("") : `<option>\u65E0\u79FB\u52A8\u89C4\u5219</option>`}</select></label>
        </div>
      </header>
      ${transferMatrixRows ? `
        <div class="device-transfer-fill" data-robot-transfer-fill-toolbar>
          <label><span>\u6279\u91CF Time</span><span class="device-time-input"><input type="number" min="0" step="any" inputmode="decimal" data-robot-transfer-fill-value aria-label="\u6279\u91CF\u586B\u5199 PrepTransTime"><span>s</span></span></label>
          <button class="btn small" type="button" data-robot-transfer-fill="0">\u586B\u5165 NoLoad</button>
          <button class="btn small" type="button" data-robot-transfer-fill="1">\u586B\u5165 OnLoad</button>
          <button class="btn small" type="button" data-robot-transfer-fill="all">\u586B\u5165\u5168\u90E8</button>
        </div>
        <div class="device-time-table-wrap"><table class="device-time-table transfer"><thead><tr><th>${counterpartField}</th><th><code>Time</code> \xB7 NoLoad <small>TransType=0</small></th><th><code>Time</code> \xB7 OnLoad <small>TransType=1</small></th></tr></thead><tbody>${transferMatrixRows}</tbody></table></div>` : `<div class="device-time-inline-empty">\u5F53\u524D ${selectedField} \u65E0\u53EF\u7F16\u8F91\u5B57\u6BB5</div>`}
    </section>`;
}
function fillRobotTransferTimes(button) {
  const toolbar = button.closest("[data-robot-transfer-fill-toolbar]");
  const input = toolbar?.querySelector("[data-robot-transfer-fill-value]");
  const value = Number(input?.value);
  const valid = input && input.value.trim() !== "" && Number.isFinite(value) && value >= 0;
  if (!valid) {
    input?.setCustomValidity("\u8BF7\u8F93\u5165\u5927\u4E8E\u6216\u7B49\u4E8E 0 \u7684\u6709\u9650\u79D2\u6570");
    input?.reportValidity();
    return;
  }
  input.setCustomValidity("");
  const robotName = state.deviceRobotName;
  const selectedAxis = state.deviceRobotTransferAxes[robotName] === "dest" ? "dest" : "src";
  const selectedField = selectedAxis === "src" ? "SrcStation" : "DestStation";
  const selectedStation = state.deviceRobotTransferSources[`${robotName}:${selectedAxis}`];
  const scope = button.dataset.robotTransferFill;
  const robot = state.baseDevice?.Robots?.[robotName];
  const draft = state.deviceTimingDraft?.robots?.[robotName];
  if (!robot || !draft || !Array.isArray(robot.PrepTransTime) || !Array.isArray(draft.PrepTransTime)) return;
  robot.PrepTransTime.forEach((row, index) => {
    const matchesStation = String(row?.[selectedField] || "") === selectedStation;
    const matchesType = scope === "all" || Number(row?.TransType) === Number(scope);
    if (matchesStation && matchesType) draft.PrepTransTime[index] = value;
  });
  markDeviceTimingDirty();
  renderDeviceRobotTiming();
}
function renderDeviceTimingConfiguration() {
  renderDeviceConfigHeader();
  renderDeviceTimingSelectors();
  document.querySelectorAll("[data-device-config-section]").forEach((button) => {
    const active = button.dataset.deviceConfigSection === state.deviceConfigSection;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.querySelectorAll("[data-device-config-view]").forEach((view) => {
    const active = view.dataset.deviceConfigView === state.deviceConfigSection;
    view.hidden = !active;
    view.classList.toggle("active", active);
  });
  if (state.deviceConfigSection === "station-time") renderDeviceStationTiming();
  if (state.deviceConfigSection === "robot-time") renderDeviceRobotTiming();
  if (state.deviceConfigSection === "robot-slot") renderRobotSlots();
  if (state.deviceConfigSection === "execution-time") renderExecutionTimingConfiguration();
}
function resetDeviceTimingDraft(message = "\u5F53\u524D\u8BBE\u5907\u65F6\u95F4\u53C2\u6570\u5DF2\u52A0\u8F7D") {
  state.deviceTimingDraft = state.baseDevice ? buildDeviceTimingDraft(state.baseDevice) : null;
  state.deviceTimingDirty = false;
  state.deviceTimingSaving = false;
  state.deviceTimingStatusMessage = state.baseDevice ? message : "\u9009\u62E9\u8BBE\u5907\u540E\u5F00\u59CB\u914D\u7F6E";
  renderDeviceTimingConfiguration();
}
function markDeviceTimingDirty() {
  if (!state.deviceTimingDraft || !state.workspaceDeviceId) return;
  state.deviceTimingDirty = true;
  state.deviceTimingStatusMessage = "\u6709\u5C1A\u672A\u4FDD\u5B58\u7684\u65F6\u95F4\u4FEE\u6539";
  renderDeviceConfigHeader();
}
function updateDeviceTimingFromControl(control) {
  const value = Number(control.value);
  const valid = control.value.trim() !== "" && Number.isFinite(value) && value >= 0;
  control.setCustomValidity(valid ? "" : "\u8BF7\u8F93\u5165\u5927\u4E8E\u6216\u7B49\u4E8E 0 \u7684\u6709\u9650\u79D2\u6570");
  control.classList.toggle("is-invalid", !valid);
  const targetName = control.dataset.deviceExecutionTarget ? "deviceExecutionTarget" : "deviceTimingTarget";
  const target = control.dataset[targetName];
  const section = target?.startsWith("station") ? "stations" : "robots";
  const root = targetName === "deviceExecutionTarget" ? state.deviceTimingDraft?.execution : state.deviceTimingDraft;
  const item = root?.[section]?.[control.dataset.deviceName];
  if (!item) return;
  if (target?.endsWith("map")) {
    item[control.dataset.timingField][control.dataset.timingKey] = valid ? value : Number.NaN;
  } else {
    item[control.dataset.timingField][Number(control.dataset.timingIndex)] = valid ? value : Number.NaN;
  }
  markDeviceTimingDirty();
}
function validateDeviceTimingDraft() {
  let invalidLabel = "";
  const timingSections = {
    stations: state.deviceTimingDraft?.stations || {},
    robots: state.deviceTimingDraft?.robots || {},
    executionStations: state.deviceTimingDraft?.execution?.stations || {},
    executionRobots: state.deviceTimingDraft?.execution?.robots || {}
  };
  Object.entries(timingSections).some(([sectionName, items]) => Object.entries(items).some(([itemName, fields]) => Object.entries(fields).some(([fieldName, values3]) => {
    const rows = Array.isArray(values3) ? values3.map((value, index) => [index, value]) : Object.entries(values3 || {});
    const invalid = rows.find(([, value]) => !Number.isFinite(Number(value)) || Number(value) < 0);
    if (!invalid) return false;
    invalidLabel = `${sectionName}.${itemName}.${fieldName}.${invalid[0]}`;
    return true;
  })));
  if (invalidLabel) throw new Error(`${invalidLabel} \u5FC5\u987B\u662F\u5927\u4E8E\u6216\u7B49\u4E8E 0 \u7684\u6709\u9650\u79D2\u6570`);
  const fluctuation = state.deviceTimingDraft?.execution?.fluctuation;
  if (fluctuation?.minimumOffsetSeconds > fluctuation?.maximumOffsetSeconds) throw new Error("\u6267\u884C\u65F6\u95F4\u6700\u5C0F\u6CE2\u52A8\u4E0D\u80FD\u5927\u4E8E\u6700\u5927\u6CE2\u52A8");
}
async function saveDeviceTiming() {
  if (!state.deviceTimingDirty || state.deviceTimingSaving || !state.workspaceDeviceId) return;
  validateDeviceTimingDraft();
  state.deviceTimingSaving = true;
  renderDeviceConfigHeader();
  try {
    const result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/device-timing`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timing: state.deviceTimingDraft })
    });
    state.workspaceDevice.device = structuredClone(result.device);
    applyDeviceTopology(result.device, state.deviceName, state.robotSlots);
    resetRunResult();
    resetDeviceTimingDraft("\u65F6\u95F4\u53C2\u6570\u5DF2\u4FDD\u5B58\u5E76\u5E94\u7528\u5230\u5168\u90E8\u6D4B\u8BD5");
    setWorkspaceStatus("\u8BBE\u5907\u65F6\u95F4\u53C2\u6570\u5DF2\u4FDD\u5B58", "saved");
  } catch (error) {
    state.deviceTimingSaving = false;
    state.deviceTimingStatusMessage = `\u4FDD\u5B58\u5931\u8D25\uFF1A${error.message}`;
    renderDeviceConfigHeader();
    throw error;
  }
}
function switchDeviceConfigSection(sectionName) {
  if (!document.querySelector(`[data-device-config-view="${sectionName}"]`)) return;
  state.deviceConfigSection = sectionName;
  renderDeviceTimingConfiguration();
}
function shortestDevicePath(source, destination) {
  const queue = [[`S:${source}`]], visited = new Set(queue[0]);
  while (queue.length) {
    const path = queue.shift(), node = path.at(-1);
    if (node === `S:${destination}`) return path.map((item) => item.slice(2));
    const [kind, name] = node.split(":");
    const neighbours = kind === "S" ? state.robotNames.filter((robot) => (state.robotScopes[robot] || []).includes(name)).map((robot) => `R:${robot}`) : (state.robotScopes[name] || []).map((station2) => `S:${station2}`);
    neighbours.forEach((next) => {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push([...path, next]);
      }
    });
  }
  return [];
}
function defaultRouteStages(routeName) {
  const port = state.loadPorts[0] || "", modules = state.processModules.slice(0, 2), outward = shortestDevicePath(port, modules[0]);
  if (outward.length < 3) return linkRouteSteps([makeStage(port), makeStage(state.robotNames[0] || ""), makeStage(modules, true, `${routeName}_Step2`), makeStage(state.robotNames[0] || ""), makeStage(port)]);
  outward[outward.length - 1] = modules;
  const full = [...outward, ...outward.slice(0, -1).reverse()];
  return linkRouteSteps(full.map((name, index) => makeStage(name, index === outward.length - 1, index === outward.length - 1 ? `${routeName}_Step${index}` : "")));
}
function makeDefaultTestCase(name = "\u9ED8\u8BA4\u6D4B\u8BD5\u96C6") {
  if (!state.routes.length) {
    const routeName2 = "RouteA";
    state.routes.push({ name: routeName2, group: routeName2, bufferOption: 0, prePJobCleanRefs: [], postPJobCleanRefs: [], postCJobCleanRefs: [], stages: defaultRouteStages(routeName2) });
  }
  const routeName = state.routes[0]?.name || "";
  return {
    name,
    group: state.activeTestGroup || "",
    strategy: "heuristic",
    roundCount: 2,
    times: [0, 70],
    options: { ...DEFAULT_SCHEDULE_OPTIONS },
    cleans: [],
    routes: state.routes.map(routeTemplateForSave),
    routeConfigs: normalizeTestRouteConfigs({}, state.routes),
    rounds: [
      makeRound(1, 0, routeName, state.loadPorts[0] || ""),
      makeRound(2, 70, routeName, state.loadPorts[1] || state.loadPorts[0] || "")
    ]
  };
}
function showWorkspaceDialog({ title, message, value = "", needsInput = false, dangerous = false }) {
  const dialog = document.getElementById("workspaceDialog"), input = document.getElementById("workspaceDialogInput"), confirm = document.getElementById("workspaceDialogConfirm");
  document.getElementById("workspaceDialogTitle").textContent = title;
  document.getElementById("workspaceDialogMessage").textContent = message;
  input.hidden = !needsInput;
  input.required = needsInput;
  input.value = value;
  confirm.textContent = dangerous ? "\u786E\u8BA4\u5220\u9664" : "\u786E\u8BA4";
  confirm.classList.toggle("danger", dangerous);
  confirm.classList.toggle("primary", !dangerous);
  dialog.showModal();
  window.setTimeout(() => (needsInput ? input : confirm).focus(), 0);
  return new Promise((resolve) => dialog.addEventListener("close", () => {
    resolve(dialog.returnValue === "confirm" ? needsInput ? input.value.trim() : true : null);
  }, { once: true }));
}
var compactSelectMenus = /* @__PURE__ */ new WeakMap();
function compactSelectMenu(wrapper) {
  return compactSelectMenus.get(wrapper) || wrapper.querySelector(".compact-select-menu");
}
function closeCompactSelect(wrapper) {
  const trigger = wrapper.querySelector(".compact-select-trigger");
  const menu = compactSelectMenu(wrapper);
  wrapper.classList.remove("is-open");
  trigger.setAttribute("aria-expanded", "false");
  menu.hidden = true;
  menu.removeAttribute("style");
  if (menu.parentElement !== wrapper) wrapper.append(menu);
}
function closeCompactSelects(exceptSelect = null) {
  document.querySelectorAll(".compact-select.is-open").forEach((wrapper) => {
    if (wrapper.querySelector("select") !== exceptSelect) closeCompactSelect(wrapper);
  });
}
function compactSelectTargets() {
  return document.querySelectorAll("select[data-compact-label], #roundList select:not([multiple])");
}
function compactSelectLabel(select) {
  return select.dataset.compactLabel || select.getAttribute("aria-label") || select.closest(".field")?.querySelector("label")?.textContent?.trim() || "\u8BF7\u9009\u62E9";
}
function refreshCompactSelect(select) {
  const wrapper = select.parentElement;
  if (!wrapper?.classList.contains("compact-select")) return;
  const trigger = wrapper.querySelector(".compact-select-trigger");
  const menu = compactSelectMenu(wrapper);
  const selectedOption = select.selectedOptions[0] || select.options[0];
  trigger.disabled = select.disabled;
  trigger.setAttribute("aria-label", `${compactSelectLabel(select)}\uFF1A${selectedOption?.textContent?.trim() || "\u672A\u9009\u62E9"}`);
  trigger.querySelector(".compact-select-value").textContent = selectedOption?.textContent?.trim() || "\u672A\u9009\u62E9";
  menu.innerHTML = Array.from(select.options).map((option, index) => `<button class="compact-select-option" type="button" role="option" data-option-index="${index}" aria-selected="${option.selected}" ${option.disabled ? "disabled" : ""}>${escapeHtml3(option.textContent?.trim() || "\u672A\u547D\u540D\u9009\u9879")}</button>`).join("");
}
function initializeCompactSelects() {
  compactSelectTargets().forEach((select) => {
    if (select.parentElement?.classList.contains("compact-select")) return;
    const wrapper = document.createElement("div");
    const trigger = document.createElement("button");
    const menu = document.createElement("div");
    wrapper.className = "compact-select";
    trigger.className = "compact-select-trigger";
    trigger.type = "button";
    trigger.setAttribute("aria-expanded", "false");
    trigger.innerHTML = `<span class="compact-select-label">${escapeHtml3(compactSelectLabel(select))}</span><span class="compact-select-value"></span><i class="compact-select-chevron" aria-hidden="true"></i>`;
    menu.className = "compact-select-menu";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", compactSelectLabel(select));
    menu.hidden = true;
    select.before(wrapper);
    wrapper.append(select, trigger, menu);
    compactSelectMenus.set(wrapper, menu);
    const setOpen = (open) => {
      if (!open) {
        closeCompactSelect(wrapper);
        return;
      }
      closeCompactSelects(select);
      const triggerBounds = trigger.getBoundingClientRect();
      (select.closest("dialog") || document.body).append(menu);
      menu.hidden = false;
      menu.style.position = "fixed";
      menu.style.top = `${triggerBounds.bottom + 6}px`;
      menu.style.left = `${triggerBounds.left}px`;
      menu.style.width = `${triggerBounds.width}px`;
      wrapper.classList.add("is-open");
      trigger.setAttribute("aria-expanded", "true");
      window.setTimeout(() => menu.querySelector("[aria-selected='true']")?.focus(), 0);
    };
    trigger.addEventListener("click", () => !select.disabled && setOpen(!wrapper.classList.contains("is-open")));
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setOpen(false);
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        setOpen(true);
      }
    });
    menu.addEventListener("click", (event) => {
      const optionButton = event.target.closest("[data-option-index]");
      if (!optionButton || optionButton.disabled) return;
      select.selectedIndex = Number(optionButton.dataset.optionIndex);
      setOpen(false);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    refreshCompactSelect(select);
  });
  if (!document.body.dataset.compactSelectCloseHandler) {
    document.body.dataset.compactSelectCloseHandler = "true";
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".compact-select, .compact-select-menu")) closeCompactSelects();
    });
  }
}
function displayDeviceName(name) {
  return String(name || "\u672A\u547D\u540D\u8BBE\u5907").replace(/\.json$/i, "");
}
function renderWorkspaceControls() {
  const deviceSelect = document.getElementById("deviceSelect"), tests = state.workspaceDevice?.tests || [];
  deviceSelect.innerHTML = state.workspaceDevices.length ? state.workspaceDevices.map((device) => `<option value="${escapeHtml3(device.id)}" ${device.id === state.workspaceDeviceId ? "selected" : ""}>${escapeHtml3(displayDeviceName(device.name))}</option>`).join("") : `<option value="">\u5C1A\u672A\u5BFC\u5165\u8BBE\u5907</option>`;
  const natural = (left, right) => left.localeCompare(right, void 0, { numeric: true });
  const ungroupedTests = tests.some((test) => !String(test.group || "").trim());
  const groups = [.../* @__PURE__ */ new Set([
    ...ungroupedTests ? [""] : [],
    ...(state.workspaceDevice?.testGroups || []).map((group) => String(group || "").trim()).filter(Boolean),
    ...tests.map((test) => String(test.group || "").trim()).filter(Boolean)
  ])].sort((left, right) => !left - !right || natural(left, right));
  const selectedGroup = groups.includes(state.activeTestGroup) ? state.activeTestGroup : groups[0] || "";
  state.activeTestGroup = selectedGroup;
  const groupSelect = document.getElementById("testGroupSelect");
  groupSelect.innerHTML = groups.length ? groups.map((group) => `<option value="${escapeHtml3(group)}" title="${escapeHtml3(group || "\u672A\u5206\u7EC4")}" ${group === selectedGroup ? "selected" : ""}>${escapeHtml3(group || "\u672A\u5206\u7EC4")}</option>`).join("") : `<option value="">\u5C1A\u65E0\u6D4B\u8BD5\u7EC4</option>`;
  groupSelect.title = selectedGroup || (groups.length ? "\u672A\u5206\u7EC4" : "\u5C1A\u65E0\u6D4B\u8BD5\u7EC4");
  groupSelect.disabled = !state.workspaceDeviceId || !groups.length;
  const testSelect = document.getElementById("testCaseSelect");
  const visibleTests = tests.filter((test) => String(test.group || "").trim() === selectedGroup).sort((left, right) => natural(left.name, right.name));
  testSelect.innerHTML = visibleTests.length ? visibleTests.map((test) => `<option value="${escapeHtml3(test.id)}" title="${escapeHtml3(test.name)}" ${test.id === state.testCaseId ? "selected" : ""}>${escapeHtml3(test.name)}</option>`).join("") : `<option value="">\u8BE5\u7EC4\u6682\u65E0\u6D4B\u8BD5</option>`;
  testSelect.title = visibleTests.find((test) => test.id === state.testCaseId)?.name || "\u8BE5\u7EC4\u6682\u65E0\u6D4B\u8BD5";
  testSelect.disabled = !visibleTests.length;
  const hasTest = Boolean(state.testCaseId);
  const nameInput = document.getElementById("testCaseName");
  nameInput.disabled = !hasTest;
  nameInput.value = state.testCaseName || "";
  nameInput.title = state.testCaseName || "";
  document.getElementById("newTestButton").disabled = !state.workspaceDeviceId;
  document.getElementById("newGroupButton").disabled = !state.workspaceDeviceId;
  document.getElementById("deleteDeviceButton").disabled = !state.workspaceDeviceId;
  const isDefaultGroup = !selectedGroup;
  const hasGroupTests = tests.some((test) => String(test.group || "").trim() === selectedGroup);
  document.getElementById("renameGroupButton").disabled = !state.workspaceDeviceId || isDefaultGroup;
  document.getElementById("deleteGroupButton").disabled = !state.workspaceDeviceId || isDefaultGroup && !hasGroupTests;
  document.getElementById("deleteGroupButton").title = isDefaultGroup ? "\u5220\u9664\u201C\u672A\u5206\u7EC4\u201D\u4E2D\u7684\u5168\u90E8\u6D4B\u8BD5" : "\u5220\u9664\u5F53\u524D\u6D4B\u8BD5\u7EC4\u522B";
  document.getElementById("groupActionHint").textContent = isDefaultGroup && state.workspaceDeviceId ? "\u201C\u672A\u5206\u7EC4\u201D\u4E0D\u53EF\u91CD\u547D\u540D\uFF1B\u6709\u6D4B\u8BD5\u65F6\u53EF\u4EE5\u5220\u9664\u5176\u4E2D\u5168\u90E8\u6D4B\u8BD5\u3002" : "";
  document.getElementById("copyTestButton").disabled = !hasTest;
  document.getElementById("saveTestButton").disabled = !hasTest;
  document.getElementById("deleteTestButton").disabled = tests.length <= 1;
  const batchDisabled = state.batchRunning && state.batchCancelRequested || singleRunActive || !state.serviceCompatible || !visibleTests.length;
  document.getElementById("batchRunButton").disabled = batchDisabled;
  const emptyHint = document.getElementById("emptyGroupHint");
  emptyHint.classList.toggle("visible", Boolean(state.workspaceDeviceId) && !visibleTests.length);
  document.getElementById("emptyGroupNewTestButton").disabled = !state.workspaceDeviceId;
  const deviceType = {
    single: "\u5355\u8154\u975E\u7EA7\u8054",
    dual: "\u53CC\u8154\u975E\u7EA7\u8054",
    cascade: "\u7EA7\u8054"
  }[detectDeviceTopologyLayout(state.device)];
  document.getElementById("deviceSummary").innerHTML = state.device ? `<span class="chip good">${escapeHtml3(deviceType)}</span>` : `<span class="chip">\u5C1A\u672A\u9009\u62E9\u8BBE\u5907</span>`;
  compactSelectTargets().forEach(refreshCompactSelect);
}
function setWorkspaceStatus(message, kind = "") {
  const status = document.getElementById("workspaceStatus");
  status.textContent = message;
  status.className = `workspace-status ${kind}`.trim();
}
var autoSaveTimer = null;
var testEditRevision = 0;
var testSaveInFlight = null;
function scheduleAutoSave() {
  window.clearTimeout(autoSaveTimer);
  autoSaveTimer = window.setTimeout(() => {
    if (state.dirty) saveCurrentTest(true).catch((error) => setWorkspaceStatus(`\u81EA\u52A8\u4FDD\u5B58\u5931\u8D25\uFF1A${error.message}`, "dirty"));
  }, 600);
}
function markTestDirty() {
  if (!state.testCaseId) return;
  testEditRevision += 1;
  state.dirty = true;
  setWorkspaceStatus(`\u201C${state.testCaseName}\u201D\u6709\u672A\u4FDD\u5B58\u4FEE\u6539`, "dirty");
  scheduleAutoSave();
}
function markRoutesDirty() {
  state.routeDirty = true;
  setWorkspaceStatus("\u5F53\u524D\u8DEF\u5F84\u6A21\u677F\u6709\u672A\u4FDD\u5B58\u4FEE\u6539\uFF0C\u8BF7\u5728\u6A21\u677F\u65C1\u70B9\u51FB\u201C\u4FDD\u5B58\u201D", "dirty");
}
function resetRunResult() {
  visualizationWorkspace.clear();
  state.batchResult = null;
  state.selectedBatchTestId = "";
  batchPerformanceAnalyses.clear();
  batchBottleneckSummaries.clear();
  batchBottleneckRequests.clear();
  batchBottleneckErrors.clear();
  batchCardAnalyses.clear();
  batchCardAnalysisRequests.clear();
  ["metricTime", "metricMakespan", "metricMoves", "metricValidation"].forEach((id) => {
    document.getElementById(id).textContent = "\u2014";
  });
  ["metricTimeDetail", "metricMakespanDetail", "metricMovesDetail", "metricValidationDetail"].forEach((id) => {
    document.getElementById(id).textContent = "";
  });
  document.getElementById("metricContext").textContent = "\u8FD0\u884C\u603B\u89C8";
  document.getElementById("batchOverviewButton").hidden = true;
  document.getElementById("testGroupAnalysisButton").hidden = true;
  document.getElementById("testGroupAnalysisPanel").hidden = true;
  document.getElementById("testGroupAnalysisPanel").innerHTML = "";
  document.getElementById("metricTimeLabel").textContent = "Total Time";
  document.getElementById("metricMakespanLabel").textContent = "Makespan";
  setBottleneckMetric(null);
  document.getElementById("metricValidationLabel").textContent = "Validation";
  document.getElementById("metricValidation").closest(".metric").classList.remove("is-success", "is-error");
  document.getElementById("batchProgress").classList.remove("visible");
  document.getElementById("batchResults").innerHTML = "";
  for (const id of ["logButton", "ganttButton", "batchGanttButton"]) {
    const link = document.getElementById(id);
    link.href = "#";
    link.setAttribute("aria-disabled", "true");
  }
  resetSearchTelemetryView();
  writeTerminal("$ \u6D4B\u8BD5\u96C6\u5DF2\u5C31\u7EEA\uFF0C\u7B49\u5F85\u8FD0\u884C\u2026");
}
function resetSearchTelemetryView() {
  searchTelemetryPollToken += 1;
  latestSearchTelemetry = null;
  selectedSearchTelemetryId = "";
  followLatestSearchTelemetry = true;
  searchTelemetryRunActive = false;
  searchTelemetryControlPending = false;
  lastSearchTelemetryMoveCount = 0;
  continuousDecisionEnabled = false;
  continuousDecisionSubmittedSearchId = "";
  userChosenActionKey = "";
  userChosenSearchId = "";
}
function applyTestCase(testCase) {
  const value = structuredClone(testCase);
  state.routeNameChanges.clear();
  state.testCaseId = value.id;
  state.testCaseName = value.name;
  state.testCaseGroup = String(value.group || "");
  state.activeTestGroup = state.testCaseGroup;
  const requestedStrategy = String(value.strategy || "heuristic");
  state.strategy = requestedStrategy.trim() || "heuristic";
  state.roundCount = Math.max(1, Number(value.roundCount) || 1);
  state.times = Array.isArray(value.times) ? value.times : [0];
  const persistedOptions = value.options && typeof value.options === "object" ? value.options : {};
  state.options = {
    ...DEFAULT_SCHEDULE_OPTIONS,
    ...Object.fromEntries(
      Object.entries(persistedOptions).filter(([key]) => SCHEDULE_OPTION_KEYS.has(key))
    )
  };
  state.options.loadLockManager = state.options.loadLockManager || "petri-look";
  const heuristicLoadLockOptionRanges = {
    loadLockDirection: [0, 1],
    loadLockCapacity: [0, 1, 2],
    loadLockBindBatch: [0, 1]
  };
  for (const [key, allowedValues] of Object.entries(heuristicLoadLockOptionRanges)) {
    const optionValue = Number(state.options[key]);
    state.options[key] = allowedValues.includes(optionValue) ? optionValue : DEFAULT_SCHEDULE_OPTIONS[key];
  }
  delete state.options.loadLockExchange;
  for (const key of ["residencyGuardSeconds", "maximumRobotHoldingSeconds", "maximumSystemResidenceCv"]) {
    const objectiveValue = Number(state.options[key]);
    state.options[key] = Number.isFinite(objectiveValue) && objectiveValue >= 0 ? objectiveValue : 0;
  }
  const macroSearchSeconds = Number(state.options.loadLockMacroSearchSeconds);
  state.options.loadLockMacroSearchSeconds = Number.isFinite(macroSearchSeconds) && macroSearchSeconds >= 0 ? macroSearchSeconds : 4;
  const macroRollouts = Number(state.options.loadLockMacroRollouts);
  state.options.loadLockMacroRollouts = Number.isFinite(macroRollouts) && macroRollouts >= 0 ? Math.floor(macroRollouts) : 96;
  if (sessionSchedulingConfiguration) {
    state.strategy = sessionSchedulingConfiguration.strategy;
    state.options = structuredClone(sessionSchedulingConfiguration.options);
  } else {
    retainSessionSchedulingConfiguration();
  }
  if (!state.routes.length && Array.isArray(value.routes)) state.routes = value.routes;
  state.cleans = Array.isArray(value.cleans) ? value.cleans.map(normalizeClean) : (state.workspaceDevice?.cleans || []).map(normalizeClean);
  state.routes.forEach((route) => normalizeRoute(route));
  captureRouteGroupingProfiles();
  state.expandedRouteProcessGroups.clear();
  state.expandedRouteGroups.clear();
  state.expandedRoutes.clear();
  state.routeProcessFilter = "";
  state.routeParallelFilter = "";
  state.rounds = Array.isArray(value.rounds) ? value.rounds : [];
  state.testRouteConfigs = normalizeTestRouteConfigs(value.routeConfigs, state.routes);
  while (state.times.length < state.roundCount) state.times.push((Number(state.times.at(-1)) || 0) + 70);
  while (state.rounds.length < state.roundCount) {
    const index = state.rounds.length;
    state.rounds.push(makeRound(index + 1, state.times[index], state.routes[0]?.name || "", state.loadPorts[index] || state.loadPorts[0] || ""));
  }
  state.times.length = state.roundCount;
  state.rounds.length = state.roundCount;
  state.times[0] = 0;
  normalizeRounds();
  normalizePJobRouteConfigs();
  state.drawer = null;
  state.routeDirty = false;
  state.routeNameChanges.clear();
  state.routeEditingIndex = -1;
  state.routeEditSnapshot = null;
  state.routeEditGroupingProfile = null;
  state.routeEditIsNew = false;
  const visualizationPlan = runtimePJobRouteInstances();
  visualizationWorkspace.setAnalysisConfiguration(visualizationPlan.routes, visualizationPlan.rounds);
  visualizationWorkspace.setReplayPlan(buildPayload());
  state.dirty = false;
  document.getElementById("roundCount").value = state.roundCount;
  document.querySelectorAll('input[name="strategy"]').forEach((input) => {
    input.checked = input.value === state.strategy;
  });
  document.querySelectorAll("[data-option]").forEach((input) => {
    const optionValue = state.options[input.dataset.option];
    if (input.type === "radio") input.checked = String(optionValue) === input.value;
    else input.value = optionValue ?? input.value;
  });
  updateStrategyOptionVisibility();
  document.getElementById("roundCount").disabled = false;
  if (Object.keys(state.algorithmMetadata).length) showAlgorithmDetails(state.strategy);
  renderAll();
  renderWorkspaceControls();
  resetRunResult();
  setWorkspaceStatus(`\u5DF2\u8F7D\u5165\u201C${state.testCaseName}\u201D`, "saved");
}
function currentTestSnapshot(name = state.testCaseName) {
  normalizeRounds();
  synchronizeCleanNames();
  return structuredClone({
    name,
    group: state.testCaseGroup,
    strategy: state.strategy,
    roundCount: state.roundCount,
    times: state.times,
    options: state.options,
    cleans: state.cleans.map(runtimeClean),
    routeConfigs: state.testRouteConfigs,
    rounds: state.rounds
  });
}
function routeTemplateSnapshot() {
  synchronizeRouteNames();
  return structuredClone({
    routes: state.routes.map(routeTemplateForSave),
    routeNameChanges: Object.fromEntries(state.routeNameChanges)
  });
}
async function saveRoutes() {
  if (!state.workspaceDeviceId) throw new Error("\u8BF7\u5148\u9009\u62E9\u8BBE\u5907");
  if (state.batchRunning) throw new Error("\u6279\u91CF\u4EFB\u52A1\u8FD0\u884C\u4E2D\uFF0C\u8BF7\u7B49\u5F85\u5B8C\u6210\u6216\u53D6\u6D88\u540E\u518D\u4FDD\u5B58\u8DEF\u5F84");
  let result;
  try {
    result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/routes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(routeTemplateSnapshot())
    });
  } catch (error) {
    setWorkspaceStatus(`\u8DEF\u5F84\u4FDD\u5B58\u5931\u8D25\uFF1A${error.message}`, "dirty");
    throw error;
  }
  state.workspaceDevice.routes = structuredClone(result.routes || state.routes);
  state.routes = structuredClone(result.routes || state.routes);
  state.routes.forEach((route) => normalizeRoute(route));
  state.testRouteConfigs = normalizeTestRouteConfigs(state.testRouteConfigs, state.routes);
  captureRouteGroupingProfiles();
  state.routeDirty = false;
  state.routeEditingIndex = -1;
  state.routeEditSnapshot = null;
  state.routeEditGroupingProfile = null;
  state.routeEditIsNew = false;
  state.routeNameChanges.clear();
  renderRoutes();
  renderWorkspaceControls();
  setWorkspaceStatus("\u8DEF\u5F84\u6A21\u677F\u5DF2\u4FDD\u5B58\uFF0C\u5206\u7EC4\u5DF2\u5237\u65B0", "saved");
  return true;
}
function beginRouteEdit(routeIndex, isNew = false) {
  if (!state.routes[routeIndex]) return false;
  if (state.routeEditingIndex >= 0 && state.routeEditingIndex !== routeIndex) {
    setWorkspaceStatus("\u8BF7\u5148\u4FDD\u5B58\u6216\u53D6\u6D88\u5F53\u524D\u6B63\u5728\u7F16\u8F91\u7684\u8DEF\u5F84\u6A21\u677F", "dirty");
    return false;
  }
  state.routeEditingIndex = routeIndex;
  state.routeEditSnapshot = isNew ? null : structuredClone(state.routes[routeIndex]);
  state.routeEditGroupingProfile = structuredClone(routeGroupingProfile(state.routes[routeIndex]));
  state.routeEditIsNew = isNew;
  state.expandedRoutes.add(routeIndex);
  renderRoutes();
  return true;
}
function cancelRouteEdit() {
  const routeIndex = state.routeEditingIndex;
  if (routeIndex < 0) return;
  if (state.routeEditIsNew) {
    state.routes.splice(routeIndex, 1);
  } else if (state.routeEditSnapshot) {
    const restored = structuredClone(state.routeEditSnapshot);
    state.routes[routeIndex] = restored;
    if (state.routeEditGroupingProfile) {
      state.routeGroupingProfiles.set(restored, structuredClone(state.routeEditGroupingProfile));
    }
  }
  state.routeEditingIndex = -1;
  state.routeEditSnapshot = null;
  state.routeEditGroupingProfile = null;
  state.routeEditIsNew = false;
  state.routeDirty = false;
  state.routeNameChanges.clear();
  state.expandedRoutes.clear();
  renderRoutes();
  setWorkspaceStatus("\u5DF2\u53D6\u6D88\u8DEF\u5F84\u6A21\u677F\u4FEE\u6539", "saved");
}
async function saveCurrentTest(silent = false) {
  if (!state.workspaceDeviceId || !state.testCaseId) return false;
  if (testSaveInFlight) {
    await testSaveInFlight;
    if (!state.dirty) return true;
  }
  const inputName = document.getElementById("testCaseName").value.trim();
  if (!inputName) {
    setWorkspaceStatus("\u6D4B\u8BD5\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A\uFF0C\u8BF7\u8F93\u5165\u540D\u79F0\u540E\u518D\u4FDD\u5B58", "dirty");
    throw new Error("\u6D4B\u8BD5\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A");
  }
  state.testCaseName = inputName;
  const deviceId = state.workspaceDeviceId;
  const testId = state.testCaseId;
  const revision = testEditRevision;
  const snapshot = currentTestSnapshot();
  const pendingSave = (async () => {
    let result;
    try {
      result = await requestJson(`/api/workspaces/${deviceId}/tests/${testId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot)
      });
    } catch (error) {
      setWorkspaceStatus(`\u4FDD\u5B58\u5931\u8D25\uFF1A${error.message}`, "dirty");
      throw error;
    }
    if (state.workspaceDeviceId !== deviceId || state.testCaseId !== testId) return true;
    const index = state.workspaceDevice.tests.findIndex((test) => test.id === testId);
    if (index >= 0) state.workspaceDevice.tests[index] = result.test;
    if (revision === testEditRevision) {
      state.testCaseName = result.test.name;
      state.dirty = false;
      state.routeNameChanges.clear();
      renderWorkspaceControls();
      setWorkspaceStatus(`${silent ? "\u5DF2\u81EA\u52A8\u4FDD\u5B58" : "\u5DF2\u4FDD\u5B58"}\u201C${state.testCaseName}\u201D`, "saved");
    } else {
      state.dirty = true;
      scheduleAutoSave();
    }
    return true;
  })();
  testSaveInFlight = pendingSave;
  try {
    return await pendingSave;
  } finally {
    if (testSaveInFlight === pendingSave) testSaveInFlight = null;
  }
}
async function createTestCase(copyCurrent = false, targetGroup = state.activeTestGroup) {
  if (!state.workspaceDeviceId) throw new Error("\u8BF7\u5148\u9009\u62E9\u8BBE\u5907");
  if (state.dirty) await saveCurrentTest(true);
  const source = copyCurrent ? currentTestSnapshot(`${state.testCaseName} \u526F\u672C`) : makeDefaultTestCase(`\u6D4B\u8BD5\u96C6 ${(state.workspaceDevice?.tests?.length || 0) + 1}`);
  source.group = targetGroup;
  const result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/tests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(source)
  });
  state.workspaceDevice.tests.push(result.test);
  const summary = state.workspaceDevices.find((device) => device.id === state.workspaceDeviceId);
  if (summary) summary.testCount = state.workspaceDevice.tests.length;
  applyTestCase(result.test);
}
async function createTestGroup() {
  const group = await showWorkspaceDialog({ title: "\u65B0\u589E\u6D4B\u8BD5\u7EC4\u522B", message: "\u8BF7\u8F93\u5165\u7EC4\u522B\u540D\u79F0\uFF1B\u65B0\u5EFA\u540E\u4F1A\u81EA\u52A8\u5207\u6362\u5230\u8BE5\u7EC4\u3002", needsInput: true });
  if (group === null) return;
  if (!group) throw new Error("\u6D4B\u8BD5\u7EC4\u522B\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A");
  const exists = (state.workspaceDevice?.testGroups || []).includes(group) || (state.workspaceDevice?.tests || []).some((test) => String(test.group || "").trim() === group);
  if (exists) throw new Error(`\u6D4B\u8BD5\u7EC4\u522B\u201C${group}\u201D\u5DF2\u7ECF\u5B58\u5728`);
  if (state.dirty) await saveCurrentTest(true);
  let result;
  try {
    result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: group })
    });
  } catch (error) {
    if (error.message === "Not found") throw new Error("\u672C\u5730\u670D\u52A1\u7248\u672C\u8FC7\u65E7\uFF0C\u8BF7\u91CD\u542F realtime_scheduler.backend.main \u540E\u518D\u65B0\u5EFA\u7EC4\u522B");
    throw error;
  }
  state.workspaceDevice.testGroups = result.groups;
  state.activeTestGroup = group;
  state.testCaseId = "";
  state.testCaseName = "";
  state.testCaseGroup = group;
  state.dirty = false;
  renderWorkspaceControls();
  resetRunResult();
  setWorkspaceStatus(`\u5DF2\u65B0\u5EFA\u6D4B\u8BD5\u7EC4\u522B\u201C${group}\u201D\uFF0C\u8BF7\u5728\u8BE5\u7EC4\u4E2D\u65B0\u5EFA\u6D4B\u8BD5`, "saved");
}
async function renameCurrentTestGroup() {
  const oldName = state.activeTestGroup;
  if (!oldName) throw new Error("\u9ED8\u8BA4\u201C\u672A\u5206\u7EC4\u201D\u4E0D\u80FD\u91CD\u547D\u540D");
  const group = await showWorkspaceDialog({ title: "\u91CD\u547D\u540D\u6D4B\u8BD5\u7EC4\u522B", message: "\u7EC4\u5185\u6D4B\u8BD5\u4F1A\u4FDD\u7559\uFF0C\u5E76\u540C\u6B65\u4F7F\u7528\u65B0\u7EC4\u522B\u540D\u79F0\u3002", value: oldName, needsInput: true });
  if (group === null || group === oldName) return;
  if (!group) throw new Error("\u6D4B\u8BD5\u7EC4\u522B\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A");
  if (state.dirty) await saveCurrentTest(true);
  const result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/groups`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ oldName, name: group })
  });
  state.workspaceDevice.testGroups = result.groups;
  state.workspaceDevice.tests = result.tests;
  state.activeTestGroup = group;
  state.testCaseGroup = group;
  const current = result.tests.find((test) => test.id === state.testCaseId);
  if (current) applyTestCase(current);
  else await selectWorkspaceGroup(group);
  setWorkspaceStatus(`\u5DF2\u5C06\u6D4B\u8BD5\u7EC4\u522B\u91CD\u547D\u540D\u4E3A\u201C${group}\u201D`, "saved");
}
async function deleteCurrentTestGroup() {
  const group = state.activeTestGroup;
  const testCount = (state.workspaceDevice?.tests || []).filter((test) => String(test.group || "").trim() === group).length;
  if (!group && !testCount) throw new Error("\u201C\u672A\u5206\u7EC4\u201D\u4E2D\u6CA1\u6709\u53EF\u5220\u9664\u7684\u6D4B\u8BD5");
  const impact = testCount ? `\u8BE5\u7EC4\u542B\u6709 ${testCount} \u4E2A\u6D4B\u8BD5\uFF0C\u5220\u9664\u540E\u8FD9\u4E9B\u6D4B\u8BD5\u5C06\u65E0\u6CD5\u6062\u590D\u3002` : "\u8BE5\u7EC4\u4E3A\u7A7A\uFF0C\u5220\u9664\u540E\u65E0\u6CD5\u6062\u590D\u3002";
  const displayName = group || "\u672A\u5206\u7EC4";
  const confirmed = await showWorkspaceDialog({ title: "\u5220\u9664\u6D4B\u8BD5\u7EC4\u522B", message: `\u786E\u5B9A\u5220\u9664\u201C${displayName}\u201D\u5417\uFF1F${impact}`, dangerous: true });
  if (!confirmed) return;
  if (state.dirty) await saveCurrentTest(true);
  const result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/groups`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: group })
  });
  state.workspaceDevice.testGroups = result.groups;
  state.workspaceDevice.tests = result.tests;
  const summary = state.workspaceDevices.find((device) => device.id === state.workspaceDeviceId);
  if (summary) summary.testCount = result.tests.length;
  const nextGroup = result.groups[0] || "";
  state.activeTestGroup = nextGroup;
  state.testCaseId = "";
  state.testCaseName = "";
  state.testCaseGroup = nextGroup;
  state.dirty = false;
  const nextTest = result.tests.find((test) => String(test.group || "").trim() === nextGroup) || result.tests[0];
  if (nextTest) {
    const nextResult = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/tests/${nextTest.id}`);
    applyTestCase(nextResult.test);
  } else {
    renderWorkspaceControls();
    resetRunResult();
    setWorkspaceStatus(`\u5DF2\u5220\u9664\u6D4B\u8BD5\u7EC4\u522B\u201C${displayName}\u201D`, "saved");
  }
}
async function deleteCurrentTest() {
  if (!state.testCaseId) return;
  const confirmed = await showWorkspaceDialog({ title: "\u5220\u9664\u6D4B\u8BD5", message: `\u786E\u5B9A\u5220\u9664\u6D4B\u8BD5\u201C${state.testCaseName}\u201D\u5417\uFF1F\u5220\u9664\u540E\u65E0\u6CD5\u6062\u590D\u3002`, dangerous: true });
  if (!confirmed) return;
  const currentGroup = state.activeTestGroup, deletedTestName = state.testCaseName;
  const result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/tests/${state.testCaseId}`, { method: "DELETE" });
  state.workspaceDevice.tests = result.tests;
  const summary = state.workspaceDevices.find((device) => device.id === state.workspaceDeviceId);
  if (summary) summary.testCount = result.tests.length;
  const nextTestInCurrentGroup = result.tests.find((test) => String(test.group || "").trim() === currentGroup);
  if (nextTestInCurrentGroup) {
    state.dirty = false;
    const nextResult = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/tests/${nextTestInCurrentGroup.id}`);
    applyTestCase(nextResult.test);
    return;
  }
  state.activeTestGroup = currentGroup;
  state.testCaseId = "";
  state.testCaseName = "";
  state.testCaseGroup = currentGroup;
  state.dirty = false;
  renderWorkspaceControls();
  resetRunResult();
  setWorkspaceStatus(`\u5DF2\u5220\u9664\u6D4B\u8BD5\u201C${deletedTestName}\u201D`, "saved");
}
async function selectWorkspaceTest(testId) {
  if (state.dirty) await saveCurrentTest(true);
  const index = state.workspaceDevice?.tests?.findIndex((test) => test.id === testId) ?? -1;
  if (index < 0) throw new Error(`\u6D4B\u8BD5\u96C6\u4E0D\u5B58\u5728\uFF1A${testId}`);
  const result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/tests/${testId}`);
  const testCase = result.test;
  state.workspaceDevice.tests[index] = testCase;
  applyTestCase(testCase);
}
async function selectWorkspaceGroup(group) {
  if (state.dirty) await saveCurrentTest(true);
  state.activeTestGroup = group;
  const testCase = state.workspaceDevice?.tests?.find((test) => String(test.group || "").trim() === group);
  if (!testCase) {
    state.testCaseId = "";
    state.testCaseName = "";
    state.testCaseGroup = group;
    state.dirty = false;
    renderWorkspaceControls();
    resetRunResult();
    setWorkspaceStatus(`\u6D4B\u8BD5\u7EC4\u522B\u201C${group || "\u672A\u5206\u7EC4"}\u201D\u6682\u65E0\u6D4B\u8BD5`, "saved");
    return;
  }
  await selectWorkspaceTest(testCase.id);
}
async function selectWorkspaceDevice(deviceId, preferredTestId = "") {
  const result = await requestJson(`/api/workspaces/${deviceId}`);
  state.workspaceDevice = result.device;
  state.workspaceDeviceId = result.device.id;
  state.activeTestGroup = "";
  state.testCaseGroup = "";
  applyDeviceTopology(result.device.device, result.device.name, result.device.robotSlots);
  resetDeviceTimingDraft();
  state.routes = Array.isArray(result.device.routes) ? structuredClone(result.device.routes) : [];
  state.cleans = Array.isArray(result.device.cleans) ? structuredClone(result.device.cleans).map(normalizeClean) : [];
  if (!result.device.tests.length) {
    const created = await requestJson(`/api/workspaces/${deviceId}/tests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeDefaultTestCase())
    });
    state.workspaceDevice.tests.push(created.test);
  }
  const summary = state.workspaceDevices.find((device) => device.id === deviceId);
  if (summary) summary.testCount = state.workspaceDevice.tests.length;
  const selected = state.workspaceDevice.tests.find((test) => test.id === preferredTestId) || state.workspaceDevice.tests[0];
  await selectWorkspaceTest(selected.id);
}
async function loadWorkspaceCatalog(preferredDeviceId = "", preferredTestId = "") {
  const result = await requestJson("/api/workspaces");
  state.workspaceDevices = result.devices;
  const deviceId = result.devices.some((device) => device.id === preferredDeviceId) ? preferredDeviceId : result.devices[0]?.id;
  if (deviceId) await selectWorkspaceDevice(deviceId, preferredTestId);
  else resetWorkspaceSelection();
}
function resetWorkspaceSelection() {
  state.workspaceDevice = null;
  state.workspaceDeviceId = "";
  state.testCaseId = "";
  state.testCaseName = "";
  state.testCaseGroup = "";
  state.activeTestGroup = "";
  state.dirty = false;
  state.deviceName = "";
  state.baseDevice = null;
  state.device = null;
  state.stationNames = [];
  state.loadPorts = [];
  state.processModules = [];
  state.robotNames = [];
  state.robotScopes = {};
  state.robotSlots = {};
  state.deviceStationName = "";
  state.deviceRobotName = "";
  state.deviceRobotTransferSources = {};
  state.deviceTimingDraft = null;
  state.deviceTimingDirty = false;
  state.deviceTimingSaving = false;
  state.deviceTimingStatusMessage = "\u9009\u62E9\u8BBE\u5907\u540E\u5F00\u59CB\u914D\u7F6E";
  renderWorkspaceControls();
  renderDeviceTimingConfiguration();
  resetRunResult();
}
async function deleteWorkspaceDevice() {
  if (!state.workspaceDeviceId) return;
  if (state.batchRunning) throw new Error("\u6279\u91CF\u4EFB\u52A1\u8FD0\u884C\u4E2D\uFF0C\u8BF7\u7B49\u5F85\u5B8C\u6210\u6216\u53D6\u6D88\u540E\u518D\u5220\u9664\u8BBE\u5907");
  const deviceName = displayDeviceName(state.workspaceDevices.find((device) => device.id === state.workspaceDeviceId)?.name || state.workspaceDevice?.name);
  const confirmed = await showWorkspaceDialog({ title: "\u5220\u9664\u8BBE\u5907", message: `\u786E\u5B9A\u5220\u9664\u8BBE\u5907\u201C${deviceName}\u201D\u5417\uFF1F\u5176\u4E0B\u5168\u90E8\u6D4B\u8BD5\u96C6\u3001\u8DEF\u7EBF\u4E0E\u6E05\u6D01\u914D\u65B9\u5C06\u4E00\u5E76\u5220\u9664\uFF0C\u4E14\u65E0\u6CD5\u6062\u590D\u3002`, dangerous: true });
  if (!confirmed) return;
  const result = await requestJson(`/api/workspaces/devices/${state.workspaceDeviceId}`, { method: "DELETE" });
  writeTerminal(`$ \u5DF2\u5220\u9664\u8BBE\u5907 ${result.deleted.name}
  \u5176\u4E0B ${result.deleted.testCount} \u4E2A\u6D4B\u8BD5\u96C6\u5DF2\u4E00\u5E76\u79FB\u9664`);
  try {
    await loadWorkspaceCatalog();
    setWorkspaceStatus(`\u5DF2\u5220\u9664\u8BBE\u5907\u201C${result.deleted.name}\u201D`, "saved");
  } catch (error) {
    state.workspaceDevices = state.workspaceDevices.filter((device) => device.id !== result.deleted.id);
    const nextDeviceId = state.workspaceDevices[0]?.id;
    if (nextDeviceId) await selectWorkspaceDevice(nextDeviceId);
    else resetWorkspaceSelection();
    setWorkspaceStatus(`\u8BBE\u5907\u5DF2\u5220\u9664\uFF0C\u4F46\u76EE\u5F55\u5237\u65B0\u5931\u8D25\uFF1A${error.message}`, "dirty");
  }
}
function switchTab(name) {
  document.querySelectorAll("[data-tab-target]").forEach((button) => button.classList.toggle("active", button.dataset.tabTarget === name));
  document.querySelectorAll("[data-tab-view]").forEach((view) => view.classList.toggle("active", view.dataset.tabView === name));
  document.getElementById("scheduleSide").classList.toggle("is-hidden", name !== "schedule");
  document.getElementById("pageLayout").classList.toggle("editor-mode", name !== "schedule");
  if (name === "device-config") renderDeviceTimingConfiguration();
  if (name !== "route") closeStepDrawer();
}
function resizeRounds(count) {
  normalizeRounds();
  const safe = Math.max(1, Math.min(8, Number(count) || 1));
  state.roundCount = safe;
  while (state.rounds.length < safe) {
    const index = state.rounds.length, priorTime = Number(state.rounds.at(-1)?.currentTime || 0);
    state.rounds.push(makeRound(index + 1, priorTime + 70, state.routes[0]?.name || "", state.loadPorts[index] || state.loadPorts[0] || ""));
  }
  state.rounds.length = safe;
  normalizeRounds();
  renderRounds();
}
function renderTimes() {
  normalizeRounds();
}
function cleanPlacementDefinitions(scope) {
  return scope === "route" ? [
    { key: "prePJobCleanRefs", label: "PJob \u524D", types: ["preclean", "dummy", "dummywac"] },
    { key: "postPJobCleanRefs", label: "PJob \u540E", types: ["postclean"] }
  ] : [
    // 腔室级清洁仅支持离开腔室后的 WAC；带 Dummy 晶圆的清洁必须绑定到 Route。
    { key: "afterCleanRefs", label: "\u79BB\u5F00\u8154\u5BA4\u540E", types: ["wacclean"] }
  ];
}
function cleanContextModules(scope, routeIndex, stageIndex = -1) {
  const route = state.routes[routeIndex];
  if (!route) return [];
  const stages = scope === "step" ? [route.stages[stageIndex]] : route.stages;
  return [...new Set((stages || []).flatMap((stage) => (stage?.visits || []).map((visit) => visit.stationName).filter((module) => state.processModules.includes(module))))];
}
function activePJobRouteContext() {
  const source = state.drawer || pjobRoutePickerContext;
  if (!source) return null;
  return {
    roundIndex: Number(source.roundIndex),
    cjobIndex: Number(source.cjobIndex),
    pjobIndex: Number(source.pjobIndex)
  };
}
function routeConfigForContext(route, context = null) {
  const target = context || activePJobRouteContext();
  const pjob = target ? state.rounds[target.roundIndex]?.cjobs[target.cjobIndex]?.pjobs[target.pjobIndex] : null;
  return pjobRouteConfig(pjob, route);
}
function cleanContextReferences(scope, routeIndex, stageIndex, placement) {
  const route = state.routes[routeIndex];
  if (!route) return [];
  const config = routeConfigForContext(route);
  if (!config) return [];
  if (scope === "route") return stringList(config[placement]);
  const stepId = String(route.stages[stageIndex]?.stepId);
  return stringList(config.stages?.[stepId]?.[placement]);
}
function setCleanContextReference(context, placement, cleanName, enabled) {
  const route = state.routes[context.routeIndex];
  if (!route) return;
  const update = (target) => {
    const names = new Set(stringList(target[placement]));
    if (enabled) names.add(cleanName);
    else names.delete(cleanName);
    target[placement] = [...names];
  };
  const config = routeConfigForContext(route, context);
  if (!config) return;
  if (context.scope === "route") update(config);
  else {
    const stepId = String(route.stages[context.stageIndex]?.stepId);
    const stageConfig = config.stages?.[stepId] || (config.stages[stepId] = stageDefaultConfig(route.stages[context.stageIndex]));
    update(stageConfig);
  }
}
function cleanReferenceCount(cleanName) {
  let count = 0;
  Object.values(state.testRouteConfigs).forEach((config) => {
    ROUTE_CLEAN_KEYS.forEach((key) => {
      if (stringList(config[key]).includes(cleanName)) count += 1;
    });
    Object.values(config.stages || {}).forEach((stage) => {
      for (const key of ["beforeCleanRefs", "afterCleanRefs"]) {
        if (stringList(stage[key]).includes(cleanName)) count += 1;
      }
    });
  });
  return count;
}
function renderContextCleans(scope, routeIndex, stageIndex = -1) {
  const rows = cleanPlacementDefinitions(scope).flatMap(
    (placement) => cleanContextReferences(scope, routeIndex, stageIndex, placement.key).map((cleanName) => ({
      cleanName,
      placement,
      clean: state.cleans.find((item) => item.name === cleanName)
    }))
  );
  if (!rows.length) return `<div class="context-clean-empty">\u5C1A\u672A\u914D\u7F6E Clean</div>`;
  return `<div class="context-clean-list">${rows.map(({ cleanName, placement, clean }) => {
    const modules = stringList(clean?.modules);
    const moduleSummary = modules.length ? modules.join(" / ") : "\u672A\u9009\u62E9\u8154\u5BA4";
    return `<div class="context-clean-item">
      <div><strong>${escapeHtml3(cleanName)}</strong><small>${escapeHtml3(placement.label)} \xB7 ${escapeHtml3(moduleSummary)}</small></div>
      <div class="context-clean-actions">
        <button class="btn small" type="button" data-action="edit-context-clean" data-clean-scope="${scope}" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" data-placement="${placement.key}" data-clean-name="${escapeHtml3(cleanName)}">\u7F16\u8F91</button>
        <button class="btn danger small" type="button" data-action="remove-context-clean" data-clean-scope="${scope}" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" data-placement="${placement.key}" data-clean-name="${escapeHtml3(cleanName)}">\u79FB\u9664</button>
      </div>
    </div>`;
  }).join("")}</div>`;
}
function updateCleanDialogFields() {
  const context = state.cleanDialogContext;
  if (!context) return;
  const placement = document.getElementById("cleanPlacement").value;
  const definition = cleanPlacementDefinitions(context.scope).find((item) => item.key === placement);
  const typeSelect = document.getElementById("cleanType");
  const currentType = typeSelect.value || context.draft.cleanType;
  typeSelect.innerHTML = CLEAN_TYPE_DEFINITIONS.filter((item) => definition?.types.includes(item.key)).map((item) => `<option value="${item.key}">${escapeHtml3(item.label)}</option>`).join("");
  typeSelect.value = definition?.types.includes(currentType) ? currentType : definition?.types[0] || "";
  const isDummyClean = ["dummy", "dummywac"].includes(typeSelect.value);
  document.getElementById("cleanTriggerField").hidden = typeSelect.value !== "wacclean" && !isDummyClean;
  document.getElementById("cleanTriggerLabel").textContent = isDummyClean ? "\u5355\u6B21\u6E05\u6D01\u5E26\u7247\u6570\uFF08MaterialCount\uFF09" : "\u89E6\u53D1\u6B21\u6570";
  document.getElementById("cleanDummyWaferCountField").hidden = !isDummyClean;
  document.getElementById("cleanDummyWaferCount").disabled = !isDummyClean;
  document.getElementById("cleanWacTimeField").hidden = typeSelect.value !== "dummywac";
}
function openCleanDialog(scope, routeIndex, stageIndex = -1, cleanName = "", placement = "") {
  const existing = state.cleans.find((clean) => clean.name === cleanName);
  const definitions = cleanPlacementDefinitions(scope);
  const selectedPlacement = definitions.some((item) => item.key === placement) ? placement : definitions[0].key;
  const draft = normalizeClean(existing || makeClean(definitions[0].types[0]));
  state.cleanDialogContext = {
    scope,
    routeIndex,
    stageIndex,
    ...activePJobRouteContext(),
    cleanName,
    originalPlacement: selectedPlacement,
    draft: structuredClone(draft)
  };
  document.getElementById("cleanDialogTitle").textContent = `${cleanName ? "\u7F16\u8F91" : "\u65B0\u589E"} ${scope === "route" ? "Job" : "RouteStep"} Clean`;
  document.getElementById("cleanDialogDescription").textContent = scope === "route" ? "Clean \u53EA\u4F5C\u7528\u4E8E\u5F53\u524D PJob \u7684\u6240\u9009\u8DEF\u5F84\uFF0C\u4E0D\u4F1A\u4FEE\u6539\u8DEF\u5F84\u6A21\u677F\u6216\u5176\u4ED6 PJob\u3002" : "Clean \u53EA\u4F5C\u7528\u4E8E\u5F53\u524D PJob \u7684\u8FD9\u4E2A Step\uFF0C\u4E0D\u4F1A\u4FEE\u6539\u8DEF\u5F84\u6A21\u677F\u6216\u5176\u4ED6 PJob\u3002";
  const placementSelect = document.getElementById("cleanPlacement");
  placementSelect.innerHTML = definitions.map((item) => `<option value="${item.key}">${escapeHtml3(item.label)}</option>`).join("");
  placementSelect.value = selectedPlacement;
  document.getElementById("cleanType").innerHTML = `<option value="${draft.cleanType}">${escapeHtml3(draft.cleanType)}</option>`;
  document.getElementById("cleanRecipeTime").value = String(draft.recipeTime);
  document.getElementById("cleanTriggerCount").value = String(draft.triggerCount);
  document.getElementById("cleanDummyWaferCount").value = String(draft.dummyWaferCount || DEFAULT_DUMMY_WAFER_COUNT);
  document.getElementById("cleanWacRecipeTime").value = String(draft.wacRecipeTime);
  const selectedModules = new Set(stringList(draft.modules));
  const moduleHost = document.getElementById("cleanModuleOptions");
  const modules = cleanContextModules(scope, routeIndex, stageIndex);
  moduleHost.innerHTML = modules.length ? modules.map((module) => `<label class="clean-module-option"><input type="checkbox" name="cleanModule" value="${escapeHtml3(module)}" ${selectedModules.has(module) ? "checked" : ""}><span>${escapeHtml3(module)}</span></label>`).join("") : `<span class="clean-dialog-empty">\u5F53\u524D\u8303\u56F4\u6CA1\u6709\u53EF\u914D\u7F6E\u7684\u52A0\u5DE5\u8154\u5BA4</span>`;
  document.getElementById("cleanDialogError").textContent = "";
  document.getElementById("deleteCleanBindingButton").hidden = !cleanName;
  updateCleanDialogFields();
  document.getElementById("cleanType").value = draft.cleanType;
  updateCleanDialogFields();
  document.getElementById("cleanDialog").showModal();
}
function saveCleanDialog() {
  const context = state.cleanDialogContext;
  if (!context) return;
  const modules = Array.from(document.querySelectorAll('#cleanModuleOptions input[name="cleanModule"]:checked'), (input) => input.value);
  if (!modules.length) {
    document.getElementById("cleanDialogError").textContent = "\u8BF7\u81F3\u5C11\u9009\u62E9\u4E00\u4E2A Clean \u9002\u7528\u8154\u5BA4\u3002";
    return;
  }
  const placement = document.getElementById("cleanPlacement").value;
  const cleanType = document.getElementById("cleanType").value;
  const clean = normalizeClean({
    ...context.draft,
    cleanType,
    recipeTime: Number(document.getElementById("cleanRecipeTime").value),
    triggerCount: Number(document.getElementById("cleanTriggerCount").value),
    materialCount: ["dummy", "dummywac"].includes(cleanType) ? Number(document.getElementById("cleanTriggerCount").value) : context.draft.materialCount,
    dummyWaferCount: ["dummy", "dummywac"].includes(cleanType) ? Number(document.getElementById("cleanDummyWaferCount").value) : 0,
    wacRecipeTime: Number(document.getElementById("cleanWacRecipeTime").value),
    modules
  });
  if (context.cleanName) {
    const cleanIndex = state.cleans.findIndex((item) => item.name === context.cleanName);
    if (cleanIndex < 0) return;
    const sharedClean = cleanReferenceCount(context.cleanName) > 1;
    if (sharedClean) {
      setCleanContextReference(context, context.originalPlacement, context.cleanName, false);
      clean.name = `__pjob_clean_${Date.now()}_${state.cleans.length}`;
      state.cleans.push(clean);
      synchronizeCleanNames();
      setCleanContextReference(context, placement, state.cleans.at(-1).name, true);
    } else {
      state.cleans[cleanIndex] = clean;
    }
    if (!sharedClean && context.originalPlacement !== placement) {
      setCleanContextReference(context, context.originalPlacement, context.cleanName, false);
      setCleanContextReference(context, placement, context.cleanName, true);
    }
  } else {
    state.cleans.push(clean);
    synchronizeCleanNames();
    const createdName = state.cleans.at(-1).name;
    setCleanContextReference(context, placement, createdName, true);
  }
  synchronizeCleanNames();
  markTestDirty();
  document.getElementById("cleanDialog").close();
  state.cleanDialogContext = null;
  renderRoutes();
  if (state.drawer) renderStepDrawer();
  if (pjobRoutePickerContext && document.getElementById("pjobRouteDialog").open) {
    renderPJobRouteDialogGroup(pjobRoutePickerContext.processKey, pjobRoutePickerContext.structureKey);
  }
}
function removeContextClean(scope, routeIndex, stageIndex, placement, cleanName) {
  const context = { scope, routeIndex, stageIndex, ...activePJobRouteContext() };
  setCleanContextReference(context, placement, cleanName, false);
  if (cleanReferenceCount(cleanName) === 0) {
    state.cleans = state.cleans.filter((clean) => clean.name !== cleanName);
  }
  markTestDirty();
  renderRoutes();
  if (state.drawer) renderStepDrawer();
  if (pjobRoutePickerContext && document.getElementById("pjobRouteDialog").open) {
    renderPJobRouteDialogGroup(pjobRoutePickerContext.processKey, pjobRoutePickerContext.structureKey);
  }
}
function renderCandidatePicker(routeIndex, stageIndex, allowed, candidates) {
  const selected = new Set(candidates);
  const summary = candidates.length ? candidates.map((name) => `<span class="chip">${escapeHtml3(name)}</span>`).join("") : `<span class="candidate-picker-empty">\u9009\u62E9\u8BBE\u5907</span>`;
  return `<details class="candidate-picker" onclick="event.stopPropagation()"><summary>${summary}</summary><div class="candidate-picker-menu">${allowed.map((name) => `<label class="candidate-option"><input type="checkbox" data-scope="stage-candidate-toggle" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" data-candidate="${escapeHtml3(name)}" ${selected.has(name) ? "checked" : ""}><span>${escapeHtml3(name)}</span></label>`).join("")}</div></details>`;
}
function refreshCandidatePicker(control) {
  const picker = control.closest(".candidate-picker");
  const routeIndex = Number(control.dataset.routeIndex);
  const stageIndex = Number(control.dataset.stageIndex);
  const route = state.routes[routeIndex];
  const stage = route?.stages?.[stageIndex];
  if (!picker || !stage) return;
  normalizeRoute(route);
  const candidates = [...new Set((stage.visits || []).map((visit) => visit.stationName).filter(Boolean))];
  const summary = picker.querySelector("summary");
  if (summary) {
    summary.innerHTML = candidates.length ? candidates.map((name) => `<span class="chip">${escapeHtml3(name)}</span>`).join("") : `<span class="candidate-picker-empty">\u9009\u62E9\u8BBE\u5907</span>`;
  }
  const row = control.closest("[data-step-card]");
  if (row) {
    const type = row.querySelector(".step-type");
    if (type) {
      type.className = `step-type ${stage.needProcess ? "process" : ""}`;
      type.textContent = stepKind(route, stageIndex);
    }
    const needProcess = row.querySelectorAll(".route-step-readonly")[1];
    if (needProcess) needProcess.textContent = stage.needProcess ? "true" : "false";
  }
}
function renderReadonlyCandidates(stage) {
  const candidates = [...new Set((stage?.visits || []).map((visit) => visit.stationName).filter(Boolean))];
  return candidates.length ? candidates.map((name) => `<span class="chip">${escapeHtml3(name)}</span>`).join("") : `<span class="candidate-picker-empty">\u672A\u9009\u62E9</span>`;
}
function renderSteps(route, routeIndex) {
  return route.stages.map((stage, stageIndex) => {
    const candidates = [...new Set((stage.visits || []).map((visit) => visit.stationName).filter(Boolean))];
    const allowed = stageUsesRobot(stage, stageIndex) ? state.robotNames : state.stationNames;
    const fixed = isFixedRouteStep(route, stageIndex);
    const picker = fixed ? `<span class="chip">\u6D4B\u8BD5 LoadPort</span>` : renderCandidatePicker(routeIndex, stageIndex, allowed, candidates);
    const actions = fixed ? `<span class="route-step-readonly">\u56FA\u5B9A\u6A21\u5757</span>` : `<div class="route-step-actions"><button class="btn icon small" title="\u524D\u79FB" data-action="move-step-up" data-route-index="${routeIndex}" data-stage-index="${stageIndex}">\u2191</button><button class="btn icon small" title="\u540E\u79FB" data-action="move-step-down" data-route-index="${routeIndex}" data-stage-index="${stageIndex}">\u2193</button><button class="btn danger icon small" title="\u5220\u9664" data-action="remove-stage" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" ${route.stages.length <= 3 ? "disabled" : ""}>\xD7</button></div>`;
    return `<tr data-route-template-step data-route-index="${routeIndex}" data-stage-index="${stageIndex}">
      <td><span class="step-id-badge">${Number(stage.stepId)}</span></td>
      <td><span class="step-type ${stage.needProcess ? "process" : ""}">${stepKind(route, stageIndex)}</span></td>
      <td>${picker}</td>
      <td class="route-step-readonly"><span class="step-next">${stage.postStepIds?.length ? stage.postStepIds.join(", ") : "\u7ED3\u675F"}</span></td>
      <td class="route-step-readonly">${stage.needProcess ? "true" : "false"}</td>
      <td>${actions}</td>
    </tr>`;
  }).join("");
}
function routeProcessProfile(route) {
  normalizeRoute(route);
  return processProfile(route);
}
function generatedRouteName(route) {
  return automaticTemplateName2(routeProcessProfile(route));
}
function recordRouteRename(oldName, newName) {
  if (!oldName || oldName === newName) return;
  let extended = false;
  for (const [origin, current] of state.routeNameChanges) {
    if (current === oldName) {
      state.routeNameChanges.set(origin, newName);
      extended = true;
    }
  }
  if (!extended) state.routeNameChanges.set(oldName, newName);
  state.rounds.forEach((round) => round.cjobs.forEach((cjob) => cjob.pjobs.forEach((pjob) => {
    if (pjob.routeRef === oldName) pjob.routeRef = newName;
  })));
  if (state.testRouteConfigs[oldName] && !state.testRouteConfigs[newName]) {
    state.testRouteConfigs[newName] = structuredClone(state.testRouteConfigs[oldName]);
    delete state.testRouteConfigs[oldName];
  }
}
function synchronizeRouteNames() {
  const occurrences = /* @__PURE__ */ new Map();
  let changed = false;
  state.routes.forEach((route) => {
    const baseName = generatedRouteName(route);
    const occurrence = (occurrences.get(baseName) || 0) + 1;
    occurrences.set(baseName, occurrence);
    const generatedName = occurrence === 1 ? baseName : `${baseName} (${occurrence})`;
    if (route.name !== generatedName) {
      recordRouteRename(route.name, generatedName);
      route.name = generatedName;
      changed = true;
    }
  });
  return changed;
}
function groupedRoutes() {
  const natural = (left, right) => left.localeCompare(right, void 0, { numeric: true });
  const processGroups = /* @__PURE__ */ new Map();
  state.routes.forEach((route, routeIndex) => {
    const profile = routeGroupingProfile(route);
    const processKey = profile.isReentrant ? profile.key : String(profile.processCount);
    const processGroup = processGroups.get(processKey) || {
      key: processKey,
      processCount: profile.processCount,
      isReentrant: profile.isReentrant,
      label: profile.processLabel,
      routeCount: 0,
      structures: /* @__PURE__ */ new Map()
    };
    const structure = processGroup.structures.get(profile.key) || { ...profile, routes: [] };
    structure.routes.push({ route, routeIndex, profile });
    processGroup.structures.set(profile.key, structure);
    processGroup.routeCount += 1;
    processGroups.set(processKey, processGroup);
    if (state.expandedRoutes.has(routeIndex)) {
      state.expandedRouteProcessGroups.add(processKey);
      state.expandedRouteGroups.add(profile.key);
    }
  });
  return [...processGroups.values()].sort((left, right) => Number(left.isReentrant) - Number(right.isReentrant) || left.processCount - right.processCount).map((processGroup) => ({
    ...processGroup,
    structures: [...processGroup.structures.values()].sort(compareProfiles).map((structure) => ({
      ...structure,
      routes: structure.routes.sort((left, right) => natural(left.route.name || "", right.route.name || ""))
    }))
  }));
}
function renderRouteDetails(route, index) {
  return `<div class="route-details"><div class="edit-card-head"><strong>\u8154\u5BA4\u8DEF\u5F84</strong><div><button class="btn small" data-action="add-stage" data-index="${index}">\uFF0B Step \u7EC4</button></div></div>
    <div class="route-table-wrap"><table class="route-table"><thead><tr><th>StepID</th><th>\u7C7B\u578B</th><th>\u53EF\u9009\u8154\u5BA4 / \u673A\u5668\u624B</th><th>PostStepID</th><th>NeedProcess</th><th></th></tr></thead><tbody>${renderSteps(route, index)}</tbody></table></div></div>`;
}
function renderRoutes() {
  const host = document.getElementById("routeList");
  const processSelect = document.getElementById("routeProcessFilter");
  const parallelSelect = document.getElementById("routeParallelFilter");
  const processGroups = groupedRoutes();
  const selectedProcess = processGroups.find((group) => group.key === state.routeProcessFilter) || processGroups[0];
  state.routeProcessFilter = selectedProcess?.key || "";
  const selectedStructure = selectedProcess?.structures.find((structure) => structure.key === state.routeParallelFilter) || selectedProcess?.structures[0];
  state.routeParallelFilter = selectedStructure?.key || "";
  processSelect.innerHTML = processGroups.map((group) => `<option value="${escapeHtml3(group.key)}">${escapeHtml3(group.label)}</option>`).join("");
  processSelect.value = state.routeProcessFilter;
  processSelect.disabled = !processGroups.length;
  parallelSelect.innerHTML = (selectedProcess?.structures || []).map((structure) => `<option value="${escapeHtml3(structure.key)}">${escapeHtml3(structure.label)}</option>`).join("");
  parallelSelect.value = state.routeParallelFilter;
  parallelSelect.disabled = !selectedProcess?.structures.length;
  initializeCompactSelects();
  refreshCompactSelect(processSelect);
  refreshCompactSelect(parallelSelect);
  if (!selectedStructure) {
    host.innerHTML = `<div class="empty">\u81F3\u5C11\u521B\u5EFA\u4E00\u6761\u8DEF\u5F84\uFF0CJob \u624D\u80FD\u5F15\u7528\u3002</div>`;
    return;
  }
  const routes = selectedStructure.routes.map(({ route, routeIndex }) => {
    const routeOpen = state.routeEditingIndex === routeIndex;
    const anotherRouteEditing = state.routeEditingIndex >= 0 && !routeOpen;
    const compactPath = routePickerCompactPath(route, false);
    const actions = routeOpen ? `<button class="btn small" type="button" disabled>\u7F16\u8F91</button><button class="btn primary small" type="button" data-action="save-route" data-route-index="${routeIndex}">\u4FDD\u5B58</button><button class="btn small" type="button" data-action="cancel-route-edit" data-route-index="${routeIndex}">\u53D6\u6D88</button>` : `<button class="btn small" type="button" data-action="edit-route" data-route-index="${routeIndex}" ${anotherRouteEditing ? "disabled" : ""}>\u7F16\u8F91</button><button class="btn small" type="button" data-action="copy-route" data-route-index="${routeIndex}" ${anotherRouteEditing ? "disabled" : ""}>\u590D\u5236</button><button class="btn danger small" type="button" data-action="remove-route" data-index="${routeIndex}" ${anotherRouteEditing ? "disabled" : ""}>\u5220\u9664</button>`;
    return `<article class="route-summary-card ${routeOpen ? "is-editing" : ""}"><div class="route-summary-head"><div class="route-summary-toggle">
      <span class="route-summary-content"><span class="route-summary-primary"><span class="route-summary-id">${routePickerShortId(route)}</span><strong title="${escapeHtml3(compactPath)}">${escapeHtml3(compactPath)}</strong></span></span></div>
      <div class="route-summary-actions">${actions}</div>
    </div>${routeOpen ? renderRouteDetails(route, routeIndex) : ""}</article>`;
  }).join("");
  host.innerHTML = routes ? `<div class="route-flat-list">${routes}</div>` : `<div class="empty">\u5F53\u524D\u7B5B\u9009\u6761\u4EF6\u4E0B\u6CA1\u6709\u5339\u914D\u7684\u8DEF\u5F84\u3002</div>`;
  initializeCompactSelects();
}
function routePickerShortId(route) {
  const routeIndex = state.routes.indexOf(route);
  return routeIndex < 0 ? "R-???" : `R-${String(routeIndex + 1).padStart(3, "0")}`;
}
function routePickerCleanInfo(cleanName) {
  const clean = state.cleans.find((item) => item.name === cleanName);
  return clean ? { ...normalizeClean(clean), defined: true } : { name: cleanName, cleanType: inferCleanType({ name: cleanName }), defined: false };
}
function routePickerWacToken(cleanName) {
  const clean = routePickerCleanInfo(cleanName);
  return clean.defined ? `wac ${Number(clean.triggerCount) || 0}|${formatCleanSeconds(clean.recipeTime)}` : "wac";
}
function routePickerStageWacTokens(stage) {
  const names = [...new Set((stage.visits || []).flatMap((visit) => [
    ...stringList(visit.beforeCleanRefs),
    ...stringList(visit.afterCleanRefs)
  ]))];
  return names.filter((name) => routePickerCleanInfo(name).cleanType === "wacclean").map(routePickerWacToken);
}
function routePickerCompactPath(route, includeTestParameters = true, sourceModule = "") {
  normalizeRoute(route);
  return (route.stages || []).map((stage, stageIndex) => {
    const candidates = [...new Set((stage.visits || []).map((visit) => String(visit.stationName || "").trim()).filter(Boolean))];
    const transferOnly = stage.kind === "robot" || candidates.length && candidates.every((name) => state.robotNames.includes(name) || /robot/i.test(name) || /^(?:ATR|VTR|DBR|UBR|TM|VTM|EFEM)(?:[_-]?\d+)?$/i.test(name));
    if (transferOnly) return "";
    const fixedSource = isFixedRouteStep(route, stageIndex);
    let node = fixedSource ? stageIndex === 0 ? "Src" : "Sink" : candidates.join("/") || "\u672A\u9009\u8154\u5BA4";
    if (includeTestParameters && stage.needProcess) {
      const processTime = Number(stage.visits?.[0]?.processTime ?? stage.visits?.[0]?.recipeTime ?? 0);
      node += `(${formatCleanSeconds(processTime)})`;
    }
    const wacTokens = includeTestParameters ? routePickerStageWacTokens(stage) : [];
    return `${node}${wacTokens.length ? `[${wacTokens.join("+")}]` : ""}`;
  }).filter(Boolean).join("->") || "\u672A\u914D\u7F6E\u8DEF\u5F84";
}
function routePickerSpecialCleanSummary(route) {
  const names = [.../* @__PURE__ */ new Set([
    ...ROUTE_CLEAN_KEYS.flatMap((key) => stringList(route[key])),
    ...(route.stages || []).flatMap((stage) => (stage.visits || []).flatMap((visit) => [
      ...stringList(visit.beforeCleanRefs),
      ...stringList(visit.afterCleanRefs)
    ]))
  ])];
  return names.map(routePickerCleanInfo).filter((clean) => ["preclean", "postclean", "dummy", "dummywac"].includes(clean.cleanType)).map((clean) => {
    if (!clean.defined) return clean.name;
    if (clean.cleanType === "dummywac") return `dummywac ${formatCleanSeconds(clean.recipeTime)}|${formatCleanSeconds(clean.wacRecipeTime)}`;
    const label = { preclean: "pre", postclean: "post", dummy: "dummy" }[clean.cleanType] || clean.cleanType;
    return `${label} ${formatCleanSeconds(clean.recipeTime)}`;
  }).join(" \xB7 ");
}
function routePickerCleanSummary(route) {
  const special = routePickerSpecialCleanSummary(route);
  const wac = [...new Set((route.stages || []).flatMap(routePickerStageWacTokens))];
  return [special, ...wac].filter(Boolean).join(" \xB7 ") || "\u65E0";
}
function routeBufferMode(value) {
  const index = Math.max(0, Math.min(4, Math.trunc(Number(value) || 0)));
  const modes = [
    { label: "No Buffer", tone: "none" },
    { label: "\u5F3A\u5236 Buffer Out", tone: "forced" },
    { label: "\u5F3A\u5236 Buffer In", tone: "forced" },
    { label: "\u975E\u5F3A\u5236 Buffer Out", tone: "optional" },
    { label: "\u975E\u5F3A\u5236 Buffer In", tone: "optional" }
  ];
  return { index, ...modes[index] };
}
function routeHasTimeConstraint(route, field) {
  return (route.stages || []).some((stage) => (stage.visits || []).some((visit) => {
    const value = Number(visit[field]);
    return Number.isFinite(value) && value >= 0;
  }));
}
function renderRoutePropertyTags(route) {
  const buffer = routeBufferMode(route.bufferOption);
  const cleanSummary = routePickerCleanSummary(route);
  const hasResidency = routeHasTimeConstraint(route, "residencyConstraint");
  const hasQTime = routeHasTimeConstraint(route, "qTimeLimit");
  const tags = [];
  if (cleanSummary !== "\u65E0") tags.push(`<span class="route-property-tag clean-active" title="\u6E05\u6D01\uFF1A${escapeHtml3(cleanSummary)}">${escapeHtml3(cleanSummary)}</span>`);
  if (hasResidency) tags.push(`<span class="route-property-tag constraint-active" title="\u9A7B\u7559\u65F6\u95F4\u7EA6\u675F\uFF1A\u5DF2\u914D\u7F6E">\u9A7B\u7559\u7EA6\u675F</span>`);
  if (buffer.index > 0) tags.push(`<span class="route-property-tag buffer-${buffer.tone}" title="Buffer \u4F7F\u7528\u6A21\u5F0F ${buffer.index}\uFF1A${escapeHtml3(buffer.label)}">${escapeHtml3(buffer.label)}</span>`);
  if (hasQTime) tags.push(`<span class="route-property-tag qtime-active" title="QTime\uFF1A\u5DF2\u914D\u7F6E">QTime</span>`);
  return tags.length ? `<span class="route-property-tags">${tags.join("")}</span>` : "";
}
function renderPJobRouteCard(route, baseline) {
  const routeIndex = state.routes.indexOf(route), selected = route === baseline;
  const compactPath = routePickerCompactPath(route, false);
  return `<button type="button" class="pjob-route-card ${selected ? "selected" : ""}" data-action="select-pjob-route" data-route-index="${routeIndex}" aria-pressed="${selected}" title="${escapeHtml3(compactPath)}">
    <span class="pjob-route-card-head"><span class="pjob-route-card-id">${routePickerShortId(route)}</span><strong class="pjob-route-card-path">${escapeHtml3(compactPath)}</strong>${selected ? `<span class="pjob-route-card-current">\u5F53\u524D\u9009\u62E9</span>` : ""}</span>
  </button>`;
}
function renderRouteInstanceSteps(route, pjob, loadPort = "") {
  const routeIndex = state.routes.indexOf(route);
  const runtimeRoute = runtimeRouteForTemplate(route, pjobRouteConfig(pjob, route));
  if (loadPort && runtimeRoute.stages?.length) {
    for (const stageIndex of [0, runtimeRoute.stages.length - 1]) {
      (runtimeRoute.stages[stageIndex]?.visits || []).forEach((visit) => {
        visit.stationName = loadPort;
      });
    }
  }
  return `<table class="route-table"><thead><tr><th>StepID</th><th>\u7C7B\u578B</th><th>\u53EF\u9009\u8154\u5BA4 / \u673A\u5668\u624B</th><th>PostStepID</th><th>NeedProcess</th></tr></thead><tbody>${(runtimeRoute.stages || []).map((stage, stageIndex) => {
    const fixed = isFixedRouteStep(runtimeRoute, stageIndex);
    return `<tr ${fixed ? "" : "data-step-card"} data-route-index="${routeIndex}" data-stage-index="${stageIndex}">
      <td><span class="step-id-badge">${Number(stage.stepId)}</span></td>
      <td>${fixed ? `<span class="route-step-source-note">\u7531 CJob LoadPort \u51B3\u5B9A</span>` : `<span class="step-type ${stage.needProcess ? "process" : ""}">${stepKind(route, stageIndex)}</span>`}</td>
      <td>${fixed ? `<span class="route-step-readonly">\u2014</span>` : renderReadonlyCandidates(stage)}</td>
      <td class="route-step-readonly"><span class="step-next">${stage.postStepIds?.length ? stage.postStepIds.join(", ") : "\u7ED3\u675F"}</span></td>
      <td class="route-step-readonly">${stage.needProcess ? "true" : "false"}</td>
    </tr>`;
  }).join("")}</tbody></table>`;
}
function renderRouteBufferEditor(routeIndex, context) {
  const route = state.routes[routeIndex];
  const pjob = state.rounds[context.roundIndex]?.cjobs[context.cjobIndex]?.pjobs[context.pjobIndex];
  const current = routeBufferMode(runtimeRouteForTemplate(route, pjobRouteConfig(pjob, route)).bufferOption).index;
  const bufferModes = ["No Buffer", "\u5F3A\u5236 Buffer Out", "\u5F3A\u5236 Buffer In", "\u975E\u5F3A\u5236 Buffer Out", "\u975E\u5F3A\u5236 Buffer In"];
  return `<section class="route-instance-buffer">
    <label for="route-${routeIndex}-buffer-option">Buffer Option</label>
    <select id="route-${routeIndex}-buffer-option" data-compact-label="Buffer Option" data-scope="test-route" data-route-index="${routeIndex}" data-round-index="${context.roundIndex}" data-cjob-index="${context.cjobIndex}" data-pjob-index="${context.pjobIndex}" data-key="bufferOption">${bufferModes.map((label, value) => `<option value="${value}" ${value === current ? "selected" : ""}>${value} \xB7 ${escapeHtml3(label)}</option>`).join("")}</select>
  </section>`;
}
function renderPJobRouteDialogGroup(processKey, structureKey) {
  const context = pjobRoutePickerContext;
  if (!context) return;
  const selectedProcess = context.groups.find((group) => group.key === processKey) || context.groups[0];
  const selectedStructure = (selectedProcess?.structures || []).find((structure) => structure.key === structureKey) || selectedProcess?.structures[0];
  const pjob = state.rounds[context.roundIndex]?.cjobs[context.cjobIndex]?.pjobs[context.pjobIndex];
  const selectedRoute = state.routes.find((route) => route.name === pjob.routeRef);
  context.processKey = selectedProcess?.key || "";
  context.structureKey = selectedStructure?.key || "";
  const filterGrid = document.getElementById("pjobRouteFilterGrid");
  const cardList = document.getElementById("pjobRouteCardList");
  const detailHost = document.getElementById("pjobRouteDetail");
  document.querySelector(".pjob-route-dialog-body")?.classList.toggle("edit-mode", context.mode === "edit" && Boolean(selectedRoute));
  if (context.mode === "edit" && selectedRoute) {
    document.getElementById("pjobRouteDialogTitle").textContent = `\u7F16\u8F91 ${pjob.jobName} \u7684\u8DEF\u5F84`;
    document.getElementById("pjobRouteDialogContext").textContent = "";
    filterGrid.hidden = true;
    cardList.hidden = true;
    detailHost.hidden = false;
    const routeIndex = state.routes.indexOf(selectedRoute);
    detailHost.innerHTML = `<article class="pjob-route-edit-card">
      <header class="pjob-route-edit-head"><button class="btn small" type="button" data-action="back-pjob-route-selection">\u2190 \u8FD4\u56DE\u9009\u62E9\u6A21\u677F</button><div><strong>${routePickerShortId(selectedRoute)}</strong></div></header>
      <div class="pjob-route-instance-settings">${renderRouteBufferEditor(routeIndex, context)}${renderRouteCleanEditor(routeIndex)}</div>
      <div class="route-table-wrap">${renderRouteInstanceSteps(selectedRoute, pjob, pjob?.loadPort)}</div>
    </article>`;
    initializeCompactSelects();
    return;
  }
  context.mode = "select";
  document.getElementById("pjobRouteDialogTitle").textContent = `\u9009\u62E9 ${pjob.jobName} \u7684\u8DEF\u5F84\u6A21\u677F`;
  filterGrid.hidden = false;
  cardList.hidden = false;
  detailHost.hidden = true;
  detailHost.innerHTML = "";
  const parallelSelect = document.getElementById("pjobRouteParallel");
  parallelSelect.innerHTML = (selectedProcess?.structures || []).map((structure) => `<option value="${escapeHtml3(structure.key)}" ${structure.key === context.structureKey ? "selected" : ""}>${escapeHtml3(structure.label)}</option>`).join("") || `<option value="">\u6682\u65E0\u7ED3\u6784</option>`;
  document.getElementById("pjobRouteDialogContext").textContent = selectedStructure ? `${selectedProcess.label} \xB7 ${selectedStructure.label} \xB7 ${selectedStructure.routes.length} \u6761\u5019\u9009\u8DEF\u5F84` : "\u5F53\u524D\u5DE5\u5E8F\u6CA1\u6709\u53EF\u7528\u8DEF\u5F84";
  cardList.innerHTML = (selectedStructure?.routes || []).length ? selectedStructure.routes.map(({ route }) => renderPJobRouteCard(route, selectedRoute)).join("") : `<div class="pjob-route-dialog-empty">\u5F53\u524D\u5DE5\u5E8F\u6CA1\u6709\u53EF\u9009\u62E9\u7684\u8DEF\u5F84</div>`;
}
function openPJobRoutePicker(button) {
  const roundIndex = Number(button.dataset.roundIndex), cjobIndex = Number(button.dataset.cjobIndex), pjobIndex = Number(button.dataset.pjobIndex);
  const pjob = state.rounds[roundIndex]?.cjobs[cjobIndex]?.pjobs[pjobIndex];
  if (!pjob) return;
  const groups = groupedRoutes();
  const selectedRoute = state.routes.find((route) => route.name === pjob.routeRef);
  const selectedProfile = selectedRoute ? routeProcessProfile(selectedRoute) : null;
  const selectedProcess = groups.find((group) => selectedProfile ? selectedProfile.isReentrant ? group.key === selectedProfile.key : group.key === String(selectedProfile.processCount) : false) || groups[0];
  const selectedStructure = (selectedProcess?.structures || []).find((structure) => structure.key === selectedProfile?.key) || selectedProcess?.structures[0];
  pjobRoutePickerContext = {
    roundIndex,
    cjobIndex,
    pjobIndex,
    trigger: button,
    groups,
    processKey: selectedProcess?.key || "",
    structureKey: selectedStructure?.key || "",
    mode: "select"
  };
  document.getElementById("pjobRouteDialogTitle").textContent = `\u9009\u62E9 ${pjob.jobName} \u7684\u8DEF\u5F84`;
  const processSelect = document.getElementById("pjobRouteProcess");
  processSelect.innerHTML = groups.length ? groups.map((group) => `<option value="${escapeHtml3(group.key)}" ${group.key === pjobRoutePickerContext.processKey ? "selected" : ""}>${escapeHtml3(group.label)}</option>`).join("") : `<option value="">\u6682\u65E0\u5DE5\u5E8F</option>`;
  renderPJobRouteDialogGroup(pjobRoutePickerContext.processKey, pjobRoutePickerContext.structureKey);
  button.setAttribute("aria-expanded", "true");
  const dialog = document.getElementById("pjobRouteDialog");
  dialog.showModal();
  window.setTimeout(() => processSelect.focus(), 0);
}
function closePJobRoutePicker(restoreFocus = true) {
  const context = pjobRoutePickerContext, dialog = document.getElementById("pjobRouteDialog");
  if (dialog.open) dialog.close();
  if (context?.trigger?.isConnected) {
    context.trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) context.trigger.focus();
  }
  pjobRoutePickerContext = null;
  renderRounds();
}
function selectPJobRoute(routeIndex) {
  const context = pjobRoutePickerContext, route = state.routes[routeIndex];
  if (!context || !route) return;
  const pjob = state.rounds[context.roundIndex]?.cjobs[context.cjobIndex]?.pjobs[context.pjobIndex];
  if (!pjob) return;
  pjob.routeRef = route.name;
  pjob.routeConfig = structuredClone(
    state.testRouteConfigs[route.name] || defaultRouteConfigForRoute(route)
  );
  normalizeRounds();
  markTestDirty();
  context.mode = "edit";
  renderPJobRouteDialogGroup(context.processKey, context.structureKey);
}
function renderPJobRoutePicker(pjob, roundIndex, cjobIndex, pjobIndex) {
  const selectedRoute = state.routes.find((route) => route.name === pjob.routeRef);
  const runtimeRoute = selectedRoute ? runtimeRouteForTemplate(selectedRoute, pjobRouteConfig(pjob, selectedRoute)) : null;
  const compactPath = runtimeRoute ? routePickerCompactPath(runtimeRoute, true, pjob.loadPort) : "\u672A\u9009\u62E9\u8DEF\u5F84";
  const common = `data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-pjob-index="${pjobIndex}"`;
  return `<div class="pjob-route-picker">
    <div class="pjob-route-current" title="${escapeHtml3(compactPath)}"><span class="pjob-route-current-path">${escapeHtml3(compactPath)}</span>${runtimeRoute ? renderRoutePropertyTags(runtimeRoute) : ""}</div>
    <button type="button" class="pjob-route-open" data-action="open-pjob-route-picker" aria-label="\u9009\u62E9\u5177\u4F53\u8DEF\u5F84" aria-haspopup="dialog" aria-controls="pjobRouteDialog" aria-expanded="false" ${common}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>
  </div>`;
}
function renderRounds() {
  normalizeRounds();
  const host = document.getElementById("roundList");
  host.innerHTML = state.rounds.map((round, roundIndex) => {
    const roundTitle = roundIndex ? `\u7B2C ${roundIndex + 1} \u8F6E\u91CD\u7B97` : "\u9996\u6B21\u6392\u7A0B";
    const serialMode = round.cjobs.some((cjob) => ["Pipeline", "Sequential"].includes(cjob.taskMode));
    const cjobs = round.cjobs.map((cjob, cjobIndex) => {
      const normalLot = cjob.jobType === "NormalLot";
      const fieldPrefix = `round-${roundIndex}-cjob-${cjobIndex}`;
      const occupiedLoadPorts = new Set(
        round.cjobs.filter((_item, index) => index !== cjobIndex).map((item) => item.loadPort)
      );
      const loadPortOptions = state.loadPorts.map((loadPort) => `<option value="${escapeHtml3(loadPort)}" ${loadPort === cjob.loadPort ? "selected" : ""} ${occupiedLoadPorts.has(loadPort) ? "disabled" : ""}>${escapeHtml3(loadPort)}</option>`).join("");
      const pjobRows = cjob.pjobs.map((pjob, pjobIndex) => {
        const pjobFieldPrefix = `${fieldPrefix}-pjob-${pjobIndex}`;
        return `<div class="pjob-row">
          <div class="pjob-identity"><span>PJob</span><strong>${escapeHtml3(pjob.jobName)}</strong></div>
          <label class="pjob-field pjob-material" for="${pjobFieldPrefix}-wafer-count"><span>Material</span><input id="${pjobFieldPrefix}-wafer-count" class="pjob-number" type="number" min="1" max="25" inputmode="numeric" data-scope="pjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-pjob-index="${pjobIndex}" data-key="waferCount" value="${Number(pjob.waferCount)}"></label>
          <label class="pjob-field pjob-priority" for="${pjobFieldPrefix}-priority"><span>Priority</span><input id="${pjobFieldPrefix}-priority" class="pjob-number" type="number" min="1" inputmode="numeric" data-scope="pjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-pjob-index="${pjobIndex}" data-key="priority" value="${Number(pjob.priority)}"></label>
          <div class="pjob-field pjob-origin-route"><span>OriginRoute</span>${renderPJobRoutePicker(pjob, roundIndex, cjobIndex, pjobIndex)}</div>
          <button class="btn danger icon pjob-remove" type="button" aria-label="\u5220\u9664 ${escapeHtml3(pjob.jobName)}" title="\u5220\u9664 ${escapeHtml3(pjob.jobName)}" data-action="remove-pjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-pjob-index="${pjobIndex}" ${cjob.pjobs.length <= 1 ? "disabled" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 11v6m4-6v6M9 7l1-2h4l1 2M7 7l1 13h8l1-13"/></svg></button>
        </div>`;
      }).join("");
      return `<section class="cjob-card">
        <header class="cjob-head">
          <div class="cjob-title"><strong>CJob ${cjobIndex + 1}</strong><span class="cjob-task-id">TaskID ${escapeHtml3(cjob.taskId)}</span></div>
          <div class="cjob-controls">
            <div class="field cjob-job-type"><label for="${fieldPrefix}-job-type">JobType</label><select id="${fieldPrefix}-job-type" data-scope="cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-key="jobType">${CJOB_TYPES.map((value) => `<option ${value === cjob.jobType ? "selected" : ""}>${value}</option>`).join("")}</select></div>
            <div class="field cjob-load-port"><label for="${fieldPrefix}-load-port">LoadPort</label><select id="${fieldPrefix}-load-port" data-scope="cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-key="loadPort" aria-label="CJob ${cjobIndex + 1} LoadPort">${loadPortOptions}</select></div>
            <div class="field cjob-priority ${normalLot ? "" : "disabled-field"}"><label for="${fieldPrefix}-priority">Priority</label><input id="${fieldPrefix}-priority" type="number" min="1" inputmode="numeric" data-scope="cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-key="priority" value="${Number(cjob.priority)}" ${normalLot ? "" : "disabled"}></div>
            <div class="field cjob-task-mode"><label for="${fieldPrefix}-task-mode">TaskMode</label><select id="${fieldPrefix}-task-mode" data-scope="cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-key="taskMode">${TASK_MODES.map((value) => `<option ${value === cjob.taskMode ? "selected" : ""} ${round.cjobs.length > 1 && ["Pipeline", "Sequential"].includes(value) ? "disabled" : ""}>${value}</option>`).join("")}</select></div>
            <div class="field cjob-cycle"><label for="${fieldPrefix}-cycle">CJobCycle</label><input id="${fieldPrefix}-cycle" type="number" min="1" max="1000" step="1" inputmode="numeric" data-scope="cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-key="cjobCycle" value="${Number(cjob.cjobCycle)}"></div>
          </div>
          <div class="round-actions cjob-actions"><button class="btn small" type="button" data-action="add-pjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>PJob</span></button><button class="btn danger small" type="button" data-action="remove-cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" ${round.cjobs.length <= 1 ? "disabled" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 11v6m4-6v6M9 7l1-2h4l1 2M7 7l1 13h8l1-13"/></svg><span>\u5220\u9664</span></button></div>
        </header>
        <div class="pjob-list">${pjobRows}</div>
      </section>`;
    }).join("");
    const cjobLimitReached = state.loadPorts.length > 0 && round.cjobs.length >= state.loadPorts.length;
    const addCJobDisabled = cjobLimitReached || serialMode;
    const addCJobTitle = serialMode ? "Pipeline/Sequential \u6BCF\u8F6E\u53EA\u80FD\u914D\u7F6E\u4E00\u4E2A CJob" : "\u6BCF\u8F6E CJob \u6570\u4E0D\u80FD\u8D85\u8FC7 LoadPort \u6570";
    return `<section class="round-card"><header class="round-head"><div class="round-summary"><div class="round-title"><div class="round-number">${roundIndex + 1}</div><strong>${roundTitle}</strong></div><label class="round-time-editor" for="round-${roundIndex}-time"><span>${roundIndex ? "\u91CD\u7B97\u65F6\u95F4" : "\u6392\u7A0B\u65F6\u95F4"}</span><span class="round-time-control"><input id="round-${roundIndex}-time" type="number" min="0" step="0.1" inputmode="decimal" data-round-time-index="${roundIndex}" value="${Number(round.currentTime)}" ${roundIndex ? "" : "disabled"}><b aria-hidden="true">s</b></span></label></div><button class="btn small round-add-cjob" type="button" data-action="add-cjob" data-round-index="${roundIndex}" ${addCJobDisabled ? `disabled title="${addCJobTitle}"` : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>CJob</span></button></header><div class="cjob-list">${cjobs}</div></section>`;
  }).join("");
  initializeCompactSelects();
}
function renderStepNumberField(label, key, value, routeIndex, stageIndex, options = {}) {
  const inputId = `step-${routeIndex}-${stageIndex}-${key}`;
  const helper = options.helper ? `<small class="field-help">${escapeHtml3(options.helper)}</small>` : "";
  const minimum = options.minimum === void 0 ? "" : ` min="${options.minimum}"`;
  return `<div class="step-edit-field">
    <label for="${inputId}">${escapeHtml3(label)}</label>
    <div class="step-number-control">
      <input id="${inputId}" type="number" inputmode="decimal" step="${options.step || "0.1"}"${minimum} data-scope="test-step" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" data-round-index="${state.drawer?.roundIndex}" data-cjob-index="${state.drawer?.cjobIndex}" data-pjob-index="${state.drawer?.pjobIndex}" data-key="${key}" value="${escapeHtml3(value)}">
      <span aria-hidden="true">s</span>
    </div>
    ${helper}
  </div>`;
}
function renderStepCleanEditor(routeIndex, stageIndex) {
  return `<section class="step-clean-section">
    <div class="context-clean-head"><div><strong>Clean</strong></div><button class="btn small" type="button" data-action="open-context-clean" data-clean-scope="step" data-route-index="${routeIndex}" data-stage-index="${stageIndex}">\uFF0B Clean</button></div>
    ${renderContextCleans("step", routeIndex, stageIndex)}
  </section>`;
}
function renderRouteCleanEditor(routeIndex) {
  return `<section class="step-clean-section">
    <div class="context-clean-head"><div><strong>Job Clean</strong></div><button class="btn small" type="button" data-action="open-context-clean" data-clean-scope="route" data-route-index="${routeIndex}" data-stage-index="-1">\uFF0B Clean</button></div>
    ${renderContextCleans("route", routeIndex)}
  </section>`;
}
function renderStepDrawer() {
  if (!state.drawer) return;
  const { routeIndex, stageIndex, roundIndex, cjobIndex, pjobIndex } = state.drawer, template = state.routes[routeIndex];
  if (!template) {
    closeStepDrawer();
    return;
  }
  const pjob = state.rounds[roundIndex]?.cjobs[cjobIndex]?.pjobs[pjobIndex];
  const route = runtimeRouteForTemplate(template, pjobRouteConfig(pjob, template)), stage = route?.stages[stageIndex];
  if (!stage || isFixedRouteStep(route, stageIndex)) {
    closeStepDrawer();
    return;
  }
  document.getElementById("drawerTitle").textContent = `Step ${stage.stepId} \u914D\u7F6E`;
  const candidates = [...new Set(stage.visits.map((visit) => visit.stationName).filter(Boolean))];
  document.getElementById("drawerSubtitle").textContent = `\u8154\u5BA4\uFF1A${candidates.join(" / ") || "\u672A\u9009\u62E9"}`;
  const first = stage.visits[0] ? normalizeVisit(stage.visits[0]) : null;
  const editor = first ? `<section class="step-editor-card" aria-label="Step \u65F6\u95F4\u53C2\u6570">
    <div class="step-edit-grid">
      ${renderStepNumberField("Process Time", "processTime", first.processTime, routeIndex, stageIndex, { minimum: 0 })}
      ${renderStepNumberField("QTime", "qTimeLimit", first.qTimeLimit, routeIndex, stageIndex)}
      ${renderStepNumberField("Residency", "residencyConstraint", first.residencyConstraint, routeIndex, stageIndex)}
    </div>
  </section>${renderStepCleanEditor(routeIndex, stageIndex)}
  <details class="step-system-details">
    <summary><strong>\u7CFB\u7EDF\u53C2\u6570</strong><span class="details-chevron" aria-hidden="true">\u2304</span></summary>
    <div class="step-system-grid">
      ${renderReadonlyField("Recipe Time", first.processTime)}
      ${renderReadonlyField("Process Recipe", first.processRecipe)}
      ${renderReadonlyField("Process Type", first.processType)}
      ${renderReadonlyField("Slot IDs", first.slotIds)}
      ${renderReadonlyField("Weight", first.weight)}
      ${renderReadonlyField("Move Time Offset", first.moveTimeOffset, true)}
    </div>
  </details>` : `<div class="empty">\u672A\u9009\u62E9\u5019\u9009\u8BBE\u5907\uFF0C\u8BF7\u5148\u5728\u8DEF\u5F84\u5217\u8868\u4E2D\u9009\u62E9\u3002</div>`;
  document.getElementById("drawerBody").innerHTML = editor;
}
function openPJobStepDrawer(routeIndex, stageIndex) {
  const route = state.routes[routeIndex];
  if (!route || isFixedRouteStep(route, stageIndex)) return;
  const context = pjobRoutePickerContext;
  if (!context) return;
  state.drawer = {
    scope: "test",
    routeIndex,
    stageIndex,
    roundIndex: context.roundIndex,
    cjobIndex: context.cjobIndex,
    pjobIndex: context.pjobIndex
  };
  renderStepDrawer();
  const drawerLayer = document.getElementById("drawerLayer");
  drawerLayer.classList.add("open");
  if (!drawerLayer.open) drawerLayer.showModal();
}
function closeStepDrawer() {
  state.drawer = null;
  const drawerLayer = document.getElementById("drawerLayer");
  drawerLayer.classList.remove("open");
  if (drawerLayer.open) drawerLayer.close();
}
function renderRobotSlots() {
  const container = document.getElementById("robotSlotList");
  const summary = document.getElementById("robotSlotSummary");
  if (!state.baseDevice || !state.robotNames.length) {
    summary.textContent = state.baseDevice ? "\u8BBE\u5907\u672A\u58F0\u660E\u673A\u5668\u624B" : "\u8BF7\u5148\u9009\u62E9\u8BBE\u5907";
    container.innerHTML = `<div class="robot-slot-empty"><span>${state.baseDevice ? "\u5F53\u524D\u8BBE\u5907\u6CA1\u6709\u53EF\u914D\u7F6E\u7684\u673A\u5668\u624B\u3002" : "\u9009\u62E9\u6216\u5BFC\u5165\u8BBE\u5907\u540E\uFF0C\u53EF\u5728\u8FD9\u91CC\u5207\u6362\u673A\u5668\u624B\u7684\u5355\u81C2\u4E0E\u53CC\u81C2\u6A21\u5F0F\u3002"}</span></div>`;
    return;
  }
  const dualArmCount = state.robotNames.filter((name) => {
    const robot = state.baseDevice.Robots[name] || {};
    const selected = state.robotSlots[name] || robotDefaultSlots(robot);
    return robotArmSlotGroups(robot).filter((group) => group.slotIds.some((slotId) => selected.includes(slotId))).length >= DUAL_ARM_SLOT_COUNT;
  }).length;
  summary.textContent = `${state.robotNames.length} \u53F0\u673A\u5668\u624B \xB7 ${dualArmCount} \u53F0\u53CC\u81C2`;
  container.innerHTML = state.robotNames.map((robotName) => {
    const robot = state.baseDevice.Robots[robotName] || {};
    const available = robotAvailableSlots(robot);
    const armGroups = robotArmSlotGroups(robot);
    const selected = state.robotSlots[robotName] || available;
    const defaults = robotDefaultSlots(robot);
    const selectedArmCount = armGroups.filter((group) => group.slotIds.some((slotId) => selected.includes(slotId))).length;
    const isDualArm = selectedArmCount >= DUAL_ARM_SLOT_COUNT;
    const supportsDualArm = armGroups.length >= DUAL_ARM_SLOT_COUNT;
    const isDefault = JSON.stringify(selected) === JSON.stringify(defaults);
    const isSaving = state.robotSlotsSaving.has(robotName);
    const accessibleStationCount = new Set(
      Object.values(robot.ArmInfo || {}).flatMap((arm) => arm?.AccessibleStations || [])
    ).size;
    const tokens = armGroups.map((group) => group.slotIds.map((slotId) => `
      <span class="robot-slot-token ${selected.includes(slotId) ? "is-active" : ""}">
        ${escapeHtml3(group.armName)} \xB7 Slot ${slotId}
      </span>
    `).join("")).join("");
    return `
      <article class="robot-slot-card" data-robot-slot-card="${escapeHtml3(robotName)}">
        <header class="robot-slot-card-head">
          <div class="robot-slot-card-title">
            <span class="robot-slot-card-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><rect x="4" y="7" width="16" height="11" rx="3"/><path d="M12 3v4M8 12h.01M16 12h.01M8 18v3m8-3v3"/></svg>
            </span>
            <div>
              <h3>${escapeHtml3(robotName)}</h3>
              <p>${escapeHtml3(robot.Type || "Robot")} \xB7 \u53EF\u8FBE ${accessibleStationCount} \u4E2A\u7AD9\u70B9</p>
            </div>
          </div>
          <span class="robot-slot-mode">${isSaving ? "\u4FDD\u5B58\u4E2D\u2026" : isDualArm ? "\u53CC\u81C2" : "\u5355\u81C2"}</span>
        </header>
        <div class="robot-slot-visual" aria-label="${escapeHtml3(robotName)} \u53EF\u7528\u69FD\u4F4D">${tokens}</div>
        <div class="robot-slot-controls" role="group" aria-label="${escapeHtml3(robotName)} \u5DE5\u4F5C\u6A21\u5F0F">
          <button class="robot-slot-choice" type="button" data-robot-slot-name="${escapeHtml3(robotName)}" data-robot-arm-count="1" aria-pressed="${String(!isDualArm)}" ${isSaving ? "disabled" : ""}>\u5355\u81C2</button>
          <button class="robot-slot-choice" type="button" data-robot-slot-name="${escapeHtml3(robotName)}" data-robot-arm-count="2" aria-pressed="${String(isDualArm)}" ${!supportsDualArm || isSaving ? "disabled" : ""}>\u53CC\u81C2</button>
          <button class="robot-slot-choice robot-slot-default" type="button" data-robot-slot-default="${escapeHtml3(robotName)}" ${isDefault || isSaving ? "disabled" : ""}>\u6062\u590D\u9ED8\u8BA4</button>
        </div>
        <p class="robot-slot-card-note">${supportsDualArm ? "\u6309\u7269\u7406 Arm \u5207\u6362\uFF1B\u6BCF\u4E2A Arm \u58F0\u660E\u7684\u591A\u4E2A\u69FD\u4F4D\u4F1A\u4E00\u8D77\u4FDD\u7559\u3002" : `\u8BBE\u5907\u6587\u4EF6\u58F0\u660E 1 \u4E2A Arm\u3001${available.length} \u4E2A\u624B\u69FD\u3002`}</p>
      </article>
    `;
  }).join("");
}
async function setRobotArmCount(robotName, armCount) {
  if (!state.workspaceDeviceId || !state.baseDevice?.Robots?.[robotName]) return;
  const armGroups = robotArmSlotGroups(state.baseDevice.Robots[robotName]);
  const boundedCount = Math.max(1, Math.min(Number(armCount) || 1, DUAL_ARM_SLOT_COUNT, armGroups.length));
  const previousSelections = structuredClone(state.robotSlots);
  const selectedSlots = armGroups.slice(0, boundedCount).flatMap((group) => group.slotIds);
  const nextSelections = { ...state.robotSlots, [robotName]: selectedSlots };
  if (JSON.stringify(previousSelections[robotName]) === JSON.stringify(nextSelections[robotName])) return;
  state.robotSlotsSaving.add(robotName);
  applyDeviceTopology(state.baseDevice, state.deviceName, nextSelections);
  renderRobotSlots();
  try {
    const result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/robot-slots`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ robotSlots: nextSelections })
    });
    state.workspaceDevice.robotSlots = structuredClone(result.robotSlots);
    applyDeviceTopology(state.baseDevice, state.deviceName, result.robotSlots);
    resetRunResult();
    setWorkspaceStatus(`\u5DF2\u4FDD\u5B58 ${robotName} \u7684${boundedCount >= DUAL_ARM_SLOT_COUNT ? "\u53CC\u81C2" : "\u5355\u81C2"}\u914D\u7F6E`, "saved");
  } catch (error) {
    applyDeviceTopology(state.baseDevice, state.deviceName, previousSelections);
    setWorkspaceStatus(`\u673A\u5668\u624B\u69FD\u4F4D\u4FDD\u5B58\u5931\u8D25\uFF1A${error.message}`, "dirty");
    throw error;
  } finally {
    state.robotSlotsSaving.delete(robotName);
    renderRobotSlots();
  }
}
async function restoreRobotSlotDefault(robotName) {
  const robot = state.baseDevice?.Robots?.[robotName];
  if (!robot) return;
  const defaults = robotDefaultSlots(robot);
  const defaultArmCount = robotArmSlotGroups(robot).filter(
    (group) => group.slotIds.some((slotId) => defaults.includes(slotId))
  ).length;
  await setRobotArmCount(robotName, defaultArmCount);
  setWorkspaceStatus(`\u5DF2\u6062\u590D ${robotName} \u7684\u8BBE\u5907\u6587\u4EF6\u9ED8\u8BA4\u914D\u7F6E`, "saved");
}
function renderAll() {
  renderTimes();
  renderRoutes();
  renderRounds();
  renderRobotSlots();
  if (state.drawer) renderStepDrawer();
}
function openSearchTreeOptionsDialog() {
  pendingSearchTreeCheckpointFile = null;
  const configuredPath = String(state.options.searchTreeModelPath || "").trim();
  document.getElementById("searchTreeCheckpointPath").value = configuredPath;
  document.getElementById("searchTreeCheckpointFile").value = "";
  document.getElementById("searchTreeCheckpointHint").textContent = configuredPath ? "\u5F53\u524D checkpoint \u5DF2\u4FDD\u5B58\u5728\u672C\u5730\u670D\u52A1\u4E2D\uFF1B\u91CD\u65B0\u9009\u62E9\u6587\u4EF6\u53EF\u66FF\u6362\u5B83\u3002" : "\u9009\u62E9\u672C\u673A checkpoint \u540E\u5C06\u4E0A\u4F20\u5230\u672C\u5730\u670D\u52A1\uFF0C\u5E76\u7528\u4E8E\u540E\u7EED\u8FD0\u884C\u3002";
  document.getElementById("searchTreeOptionsDialog").showModal();
}
function openHeuristicSettingsDialog() {
  document.getElementById("heuristicSettingsError").textContent = "";
  const configured = state.options.heuristicConfig && typeof state.options.heuristicConfig === "object" ? state.options.heuristicConfig : null;
  document.getElementById("heuristicCustomWeightsEnabled").checked = Boolean(configured);
  document.querySelectorAll("[data-heuristic-weight]").forEach((input) => {
    const key = input.dataset.heuristicWeight;
    input.value = configured?.[key] ?? DEFAULT_HEURISTIC_WEIGHTS[key];
  });
  for (const key of ["loadLockDirection", "loadLockCapacity", "loadLockBindBatch"]) {
    document.querySelectorAll(`[data-heuristic-dialog-option="${key}"]`).forEach((input) => {
      input.checked = String(state.options[key]) === input.value;
    });
  }
  updateHeuristicWeightEditorState();
  document.getElementById("heuristicSettingsDialog").showModal();
}
function updateHeuristicWeightEditorState() {
  const enabled = document.getElementById("heuristicCustomWeightsEnabled")?.checked === true;
  document.querySelectorAll("[data-heuristic-weight]").forEach((input) => {
    input.disabled = !enabled;
  });
  document.getElementById("heuristicWeightFields")?.classList.toggle("is-disabled", !enabled);
}
function saveHeuristicSettings() {
  for (const key of ["loadLockDirection", "loadLockCapacity", "loadLockBindBatch"]) {
    const input = document.querySelector(`[data-heuristic-dialog-option="${key}"]:checked`);
    state.options[key] = Number(input?.value);
  }
  if (document.getElementById("heuristicCustomWeightsEnabled").checked) {
    const weights = {};
    document.querySelectorAll("[data-heuristic-weight]").forEach((input) => {
      const value = Number(input.value);
      if (!Number.isFinite(value)) throw new Error(`${input.dataset.heuristicWeight} \u5FC5\u987B\u662F\u6709\u9650\u6570\u5B57`);
      weights[input.dataset.heuristicWeight] = value;
    });
    state.options.heuristicConfig = weights;
  } else state.options.heuristicConfig = null;
  retainSessionSchedulingConfiguration();
  markTestDirty();
  document.getElementById("heuristicSettingsDialog").close();
}
async function uploadSearchTreeCheckpoint(file) {
  const response = await fetch("/api/model-checkpoints", {
    method: "POST",
    headers: { "X-Checkpoint-Filename": encodeURIComponent(file.name) },
    body: file
  });
  const result = await response.json();
  if (!response.ok || !result.ok || !result.modelPath) {
    throw new Error(result.error || `checkpoint \u4E0A\u4F20\u5931\u8D25\uFF08${response.status}\uFF09`);
  }
  return String(result.modelPath);
}
async function saveSearchTreeOptions() {
  const saveButton = document.getElementById("saveSearchTreeOptionsButton");
  saveButton.disabled = true;
  try {
    const modelPath = pendingSearchTreeCheckpointFile ? await uploadSearchTreeCheckpoint(pendingSearchTreeCheckpointFile) : String(document.getElementById("searchTreeCheckpointPath").value || "").trim();
    state.options.searchTreeModelPath = modelPath;
    pendingSearchTreeCheckpointFile = null;
    retainSessionSchedulingConfiguration();
    markTestDirty();
    renderAll();
    document.getElementById("searchTreeOptionsDialog").close();
  } finally {
    saveButton.disabled = false;
  }
}
function updateStateFromControl(control) {
  let value = control.multiple ? Array.from(control.selectedOptions, (item) => item.value) : control.type === "checkbox" ? control.checked : control.type === "number" ? Number(control.value) : control.value;
  const key = control.dataset.key;
  const scope = control.dataset.scope;
  const routeControl = ["stage-candidates", "stage-candidate-toggle"].includes(scope);
  if (routeControl) markRoutesDirty();
  else markTestDirty();
  if (control.dataset.timeIndex !== void 0) {
    state.times[Number(control.dataset.timeIndex)] = value;
    return;
  }
  if (control.dataset.roundTimeIndex !== void 0) {
    const roundIndex = Number(control.dataset.roundTimeIndex);
    state.rounds[roundIndex].currentTime = roundIndex ? Math.max(0, value) : 0;
    state.times[roundIndex] = state.rounds[roundIndex].currentTime;
    return;
  }
  if (control.dataset.option) {
    if (["loadLockDirection", "loadLockCapacity", "loadLockBindBatch"].includes(control.dataset.option)) {
      value = Number(control.value);
    }
    if (["residencyGuardSeconds", "maximumRobotHoldingSeconds", "maximumSystemResidenceCv"].includes(control.dataset.option)) {
      value = Number.isFinite(value) ? Math.max(0, value) : 0;
      control.value = value;
    }
    state.options[control.dataset.option] = value;
    retainSessionSchedulingConfiguration();
    return;
  }
  if (scope === "stage-candidates") setStageCandidates(Number(control.dataset.routeIndex), Number(control.dataset.stageIndex), Array.from(control.selectedOptions, (item) => item.value));
  if (scope === "stage-candidate-toggle") {
    const routeIndex = Number(control.dataset.routeIndex), stageIndex = Number(control.dataset.stageIndex);
    const current = new Set(state.routes[routeIndex].stages[stageIndex].visits.map((visit) => visit.stationName));
    if (control.checked) current.add(control.dataset.candidate);
    else current.delete(control.dataset.candidate);
    setStageCandidates(routeIndex, stageIndex, [...current]);
  }
  if (scope === "test-route") {
    const route = state.routes[Number(control.dataset.routeIndex)];
    const pjob = state.rounds[Number(control.dataset.roundIndex)]?.cjobs[Number(control.dataset.cjobIndex)]?.pjobs[Number(control.dataset.pjobIndex)];
    const config = pjobRouteConfig(pjob, route);
    config[key] = ROUTE_CLEAN_KEYS.includes(key) ? value ? [value] : [] : value;
  }
  if (scope === "test-step") {
    const route = state.routes[Number(control.dataset.routeIndex)];
    const stage = route.stages[Number(control.dataset.stageIndex)];
    const pjob = state.rounds[Number(control.dataset.roundIndex)]?.cjobs[Number(control.dataset.cjobIndex)]?.pjobs[Number(control.dataset.pjobIndex)];
    const config = pjobRouteConfig(pjob, route);
    const stepId = String(stage.stepId);
    const stageConfig = config.stages[stepId] || (config.stages[stepId] = stageDefaultConfig(stage));
    stageConfig[key] = structuredClone(value);
    if (key === "processTime") stageConfig.recipeTime = Number(value);
  }
  if (scope === "cjob") {
    const round = state.rounds[Number(control.dataset.roundIndex)];
    const cjob = round.cjobs[Number(control.dataset.cjobIndex)];
    if (key === "taskMode" && ["Pipeline", "Sequential"].includes(String(value)) && round.cjobs.length > 1) {
      control.value = cjob.taskMode;
      return;
    }
    if (key === "cjobCycle") {
      value = Math.max(1, Math.min(1e3, Math.trunc(Number(value) || 1)));
      control.value = String(value);
    }
    cjob[key] = value;
    if (key === "loadPort") cjob.pjobs.forEach((pjob) => {
      pjob.loadPort = String(value);
    });
    if (key === "jobType") cjob.priority = value === "NormalLot" ? cjob.priority > 0 ? cjob.priority : 1 : -1;
    normalizeRounds();
  }
  if (scope === "pjob") {
    const pjob = state.rounds[Number(control.dataset.roundIndex)].cjobs[Number(control.dataset.cjobIndex)].pjobs[Number(control.dataset.pjobIndex)];
    pjob[key] = value;
    normalizeRounds();
  }
}
function handleAction(button) {
  const action = button.dataset.action, index = Number(button.dataset.index), routeIndex = Number(button.dataset.routeIndex), stageIndex = Number(button.dataset.stageIndex);
  let routeAction = false;
  if (action === "open-pjob-route-picker") {
    openPJobRoutePicker(button);
    return;
  }
  if (action === "select-pjob-route") {
    selectPJobRoute(routeIndex);
    return;
  }
  if (action === "back-pjob-route-selection") {
    if (pjobRoutePickerContext) {
      pjobRoutePickerContext.mode = "select";
      renderPJobRouteDialogGroup(pjobRoutePickerContext.processKey, pjobRoutePickerContext.structureKey);
    }
    return;
  }
  if (action === "save-route") {
    saveRoutes().catch((error) => writeTerminal(`$ \u8DEF\u5F84\u4FDD\u5B58\u5931\u8D25
  ${error.message}`, true));
    return;
  }
  if (action === "cancel-route-edit") {
    cancelRouteEdit();
    return;
  }
  if (action === "open-pjob-step-drawer") {
    openPJobStepDrawer(routeIndex, stageIndex);
    return;
  }
  if (action === "open-context-clean" || action === "edit-context-clean") {
    openCleanDialog(
      button.dataset.cleanScope,
      routeIndex,
      Number.isFinite(stageIndex) ? stageIndex : -1,
      action === "edit-context-clean" ? button.dataset.cleanName || "" : "",
      button.dataset.placement || ""
    );
    return;
  }
  if (action === "remove-context-clean") {
    removeContextClean(
      button.dataset.cleanScope,
      routeIndex,
      Number.isFinite(stageIndex) ? stageIndex : -1,
      button.dataset.placement,
      button.dataset.cleanName
    );
    return;
  }
  if (action === "delete-clean-binding") {
    const context = state.cleanDialogContext;
    if (context?.cleanName) {
      removeContextClean(
        context.scope,
        context.routeIndex,
        context.stageIndex,
        context.originalPlacement,
        context.cleanName
      );
    }
    document.getElementById("cleanDialog").close();
    state.cleanDialogContext = null;
    return;
  }
  if (action === "toggle-route-group") {
    const key = button.dataset.groupKey;
    if (state.expandedRouteGroups.has(key)) state.expandedRouteGroups.delete(key);
    else state.expandedRouteGroups.add(key);
    renderRoutes();
    return;
  }
  if (action === "toggle-route-process-group") {
    const key = button.dataset.processKey;
    if (state.expandedRouteProcessGroups.has(key)) state.expandedRouteProcessGroups.delete(key);
    else state.expandedRouteProcessGroups.add(key);
    renderRoutes();
    return;
  }
  if (action === "edit-route") {
    const profile = routeGroupingProfile(state.routes[routeIndex]);
    state.routeProcessFilter = profile.isReentrant ? profile.key : String(profile.processCount);
    state.routeParallelFilter = profile.key;
    state.expandedRouteProcessGroups.add(String(profile.processCount));
    state.expandedRouteGroups.add(profile.key);
    beginRouteEdit(routeIndex);
    return;
  }
  if (action === "add-route") {
    if (state.routeEditingIndex >= 0) {
      setWorkspaceStatus("\u8BF7\u5148\u4FDD\u5B58\u6216\u53D6\u6D88\u5F53\u524D\u6B63\u5728\u7F16\u8F91\u7684\u8DEF\u5F84\u6A21\u677F", "dirty");
      return;
    }
    const name = `Route${state.routes.length + 1}`, route = { name, group: name, bufferOption: 0, prePJobCleanRefs: [], postPJobCleanRefs: [], postCJobCleanRefs: [], stages: state.device ? defaultRouteStages(name) : linkRouteSteps([makeStage(""), makeStage(""), makeStage("", true, `${name}_Step2`), makeStage(""), makeStage("")]) };
    state.routes.push(route);
    state.routeGroupingProfiles.set(route, structuredClone(routeProcessProfile(route)));
    const newIndex = state.routes.length - 1, profile = routeProcessProfile(route);
    state.expandedRoutes.add(newIndex);
    state.routeProcessFilter = profile.isReentrant ? profile.key : String(profile.processCount);
    state.routeParallelFilter = profile.key;
    state.expandedRouteProcessGroups.add(String(profile.processCount));
    state.expandedRouteGroups.add(profile.key);
    beginRouteEdit(newIndex, true);
    routeAction = true;
  }
  if (action === "copy-route") {
    if (state.routeEditingIndex >= 0) {
      setWorkspaceStatus("\u8BF7\u5148\u4FDD\u5B58\u6216\u53D6\u6D88\u5F53\u524D\u6B63\u5728\u7F16\u8F91\u7684\u8DEF\u5F84\u6A21\u677F", "dirty");
      return;
    }
    const source = state.routes[routeIndex], base = `${source.name || "Route"} \u526F\u672C`, occupied = new Set(state.routes.map((route) => route.name));
    let name = base, suffix = 2;
    while (occupied.has(name)) name = `${base} (${suffix++})`;
    const copy = structuredClone(source);
    copy.name = name;
    state.routes.push(copy);
    state.routeGroupingProfiles.set(copy, structuredClone(routeProcessProfile(copy)));
    const newIndex = state.routes.length - 1, profile = routeProcessProfile(copy);
    state.expandedRoutes.add(newIndex);
    state.routeProcessFilter = profile.isReentrant ? profile.key : String(profile.processCount);
    state.routeParallelFilter = profile.key;
    state.expandedRouteProcessGroups.add(String(profile.processCount));
    state.expandedRouteGroups.add(profile.key);
    beginRouteEdit(newIndex, true);
    routeAction = true;
  }
  if (action === "remove-route") {
    if (state.routeEditingIndex >= 0) {
      setWorkspaceStatus("\u8BF7\u5148\u4FDD\u5B58\u6216\u53D6\u6D88\u5F53\u524D\u6B63\u5728\u7F16\u8F91\u7684\u8DEF\u5F84\u6A21\u677F", "dirty");
      return;
    }
    state.routes.splice(index, 1);
    state.expandedRoutes.clear();
    state.expandedRouteProcessGroups.clear();
    state.expandedRouteGroups.clear();
    if (state.drawer?.routeIndex === index) closeStepDrawer();
    markRoutesDirty();
    saveRoutes().catch((error) => writeTerminal(`$ \u8DEF\u5F84\u5220\u9664\u5931\u8D25
  ${error.message}`, true));
    return;
  }
  if (action === "add-stage") {
    state.routes[index].stages.splice(-1, 0, makeStage(""), makeStage(""));
    linkRouteSteps(state.routes[index].stages);
    routeAction = true;
  }
  if (action === "remove-stage" && !isFixedRouteStep(state.routes[routeIndex], stageIndex)) {
    state.routes[routeIndex].stages.splice(stageIndex, 1);
    linkRouteSteps(state.routes[routeIndex].stages);
    closeStepDrawer();
    routeAction = true;
  }
  if (action === "move-step-up" && stageIndex > 0 && !isFixedRouteStep(state.routes[routeIndex], stageIndex)) {
    [state.routes[routeIndex].stages[stageIndex - 1], state.routes[routeIndex].stages[stageIndex]] = [state.routes[routeIndex].stages[stageIndex], state.routes[routeIndex].stages[stageIndex - 1]];
    linkRouteSteps(state.routes[routeIndex].stages);
    routeAction = true;
  }
  if (action === "move-step-down" && stageIndex < state.routes[routeIndex].stages.length - 1 && !isFixedRouteStep(state.routes[routeIndex], stageIndex)) {
    [state.routes[routeIndex].stages[stageIndex + 1], state.routes[routeIndex].stages[stageIndex]] = [state.routes[routeIndex].stages[stageIndex], state.routes[routeIndex].stages[stageIndex + 1]];
    linkRouteSteps(state.routes[routeIndex].stages);
    routeAction = true;
  }
  if (action === "add-cjob") {
    const roundIndex = Number(button.dataset.roundIndex), round = state.rounds[roundIndex];
    if (round.cjobs.some((cjob2) => ["Pipeline", "Sequential"].includes(cjob2.taskMode))) return;
    if (state.loadPorts.length && round.cjobs.length >= state.loadPorts.length) return;
    const cjob = makeCJob(roundIndex + 1, [], state.routes[0]?.name || "", state.loadPorts[round.cjobs.length] || state.loadPorts[0] || "");
    cjob.key = `C${round.cjobs.length + 1}`;
    round.cjobs.push(cjob);
  }
  if (action === "remove-cjob") state.rounds[Number(button.dataset.roundIndex)].cjobs.splice(Number(button.dataset.cjobIndex), 1);
  if (action === "add-pjob") {
    const roundIndex = Number(button.dataset.roundIndex), cjob = state.rounds[roundIndex].cjobs[Number(button.dataset.cjobIndex)];
    cjob.pjobs.push(makePJob(cjob.pjobs.length + 1, state.routes[0]?.name || "", cjob.loadPort || state.loadPorts[0] || "", 5));
  }
  if (action === "remove-pjob") state.rounds[Number(button.dataset.roundIndex)].cjobs[Number(button.dataset.cjobIndex)].pjobs.splice(Number(button.dataset.pjobIndex), 1);
  normalizeRounds();
  if (routeAction) {
    markRoutesDirty();
    renderRoutes();
    if (state.drawer) renderStepDrawer();
  } else {
    markTestDirty();
    renderAll();
  }
}
function collectRecipes(routes = state.routes) {
  const recipes = [];
  const cleanByName = new Map(state.cleans.map(runtimeClean).map((clean) => [clean.name, clean]));
  function standardProcessWeight(visit) {
    const rawWeight = visit.weight ?? "{}";
    let weight;
    try {
      weight = typeof rawWeight === "string" ? JSON.parse(rawWeight || "{}") : structuredClone(rawWeight || {});
    } catch (_error) {
      return rawWeight;
    }
    if (!weight || typeof weight !== "object" || Array.isArray(weight)) return rawWeight;
    [...stringList(visit.beforeCleanRefs), ...stringList(visit.afterCleanRefs)].forEach((cleanName) => {
      const clean = cleanByName.get(cleanName);
      if (!stringList(clean?.modules).includes(visit.stationName)) return;
      const stateVariable = String(clean?.stateVariable || "").trim();
      if (stateVariable && stateVariable !== "IdleTime" && weight[stateVariable] === void 0) {
        weight[stateVariable] = 1;
      }
    });
    return JSON.stringify(weight);
  }
  function add(name, time, modules, processType = "", weightText = "{}") {
    const weight = typeof weightText === "string" ? weightText : JSON.stringify(weightText ?? {}), moduleList = stringList(modules);
    const existing = recipes.find((recipe) => recipe.name === name && Number(recipe.time) === Number(time) && recipe.processType === processType && recipe.weight === weight);
    if (existing) {
      existing.modules = [.../* @__PURE__ */ new Set([...existing.modules, ...moduleList])];
    } else recipes.push({ name, time: Number(time), modules: moduleList, processType, weight });
  }
  routes.forEach((route) => {
    normalizeRoute(route);
    route.stages.forEach((stage) => stage.visits.forEach((visit) => {
      if (visit.processRecipe) add(visit.processRecipe, visit.processTime, [visit.stationName], visit.processType, standardProcessWeight(visit));
    }));
  });
  state.cleans.map(runtimeClean).forEach((clean) => {
    add(clean.recipeRef, clean.recipeTime, clean.modules);
    if (clean.cleanType === "dummywac") add(clean.emptyRecipeRef, clean.wacRecipeTime, clean.modules);
  });
  return recipes;
}
function stationSlotList(stationName) {
  const station2 = state.device?.Stations?.[stationName];
  if (station2) {
    if (Array.isArray(station2.Slots) && station2.Slots.length) return station2.Slots.map(Number);
    const capacity = Number(station2.Capacity) || 0;
    return capacity >= 1 ? Array.from({ length: capacity }, (_, index) => index + 1) : [1];
  }
  const robot = state.device?.Robots?.[stationName];
  return robot ? robotDefaultSlots(robot) : [1];
}
function expandVisitSlotIds() {
  if (!state.device) return;
  for (const route of state.routes) {
    for (const stage of route.stages || []) {
      for (const visit of stage.visits || []) {
        const stationName = String(visit.stationName || "").trim();
        if (!stationName) continue;
        const slots = stationSlotList(stationName);
        visit.slotIds = slots.join(",");
      }
    }
  }
}
function runtimePJobRouteInstances() {
  const rounds = structuredClone(state.rounds);
  const routes = [];
  rounds.forEach((round, roundIndex) => round.cjobs.forEach((cjob, cjobIndex) => {
    cjob.pjobs.forEach((pjob, pjobIndex) => {
      const sourcePJob = state.rounds[roundIndex].cjobs[cjobIndex].pjobs[pjobIndex];
      const template = state.routes.find((route2) => route2.name === sourcePJob.routeRef);
      if (!template) return;
      const route = runtimeRouteForTemplate(template, pjobRouteConfig(sourcePJob, template));
      const suffix = `r${roundIndex + 1}-t${cjob.taskId}-c${cjobIndex + 1}-p${pjobIndex + 1}`;
      route.name = `${template.name}__${suffix}`;
      route.stages.forEach((stage) => stage.visits.forEach((visit) => {
        if (visit.processRecipe) visit.processRecipe = `${visit.processRecipe}__${suffix}`;
      }));
      pjob.routeRef = route.name;
      delete pjob.routeConfig;
      routes.push(route);
    });
  }));
  return { routes, rounds };
}
function buildPayload() {
  normalizeRounds();
  expandVisitSlotIds();
  normalizePJobRouteConfigs();
  const instances = runtimePJobRouteInstances();
  const routes = instances.routes.map((route) => ({ ...normalizeRoute(route), stages: route.stages.map((stage) => ({ ...stage, visits: stage.visits.map((visit) => structuredClone(visit)) })) }));
  const cleans = state.cleans.map(runtimeClean);
  const options = schedulingRequestOptions();
  if (state.strategy === "search-tree") {
    options.searchTreeExecutionMode = "continuous";
  }
  return { schemaVersion: EXPECTED_API_SCHEMA, workspaceDeviceId: state.workspaceDeviceId, workspaceTestId: state.testCaseId, deviceName: state.deviceName, device: state.device, strategy: state.strategy, roundCount: state.roundCount, options, hongYeCheck: hongYeCheckEnabled(), compatibilityMode: compatibilityModeEnabled(), executionTimingEnabled: executionTimingEnabled(), skipBaseline: skipBaselineEnabled(), cleanValidationTypes: cleanValidationTypes(), recipes: collectRecipes(routes), cleans, routes, rounds: instances.rounds };
}
function schedulingRequestOptions() {
  if (state.strategy !== "heuristic") return { ...state.options };
  const options = Object.fromEntries(
    ["loadLockDirection", "loadLockCapacity", "loadLockBindBatch"].map((key) => [key, state.options[key]])
  );
  if (state.options.heuristicConfig) options.heuristicConfig = structuredClone(state.options.heuristicConfig);
  return options;
}
function clampParallelismInput(elementId, min, max, fallback) {
  const input = document.getElementById(elementId);
  if (!input) return fallback;
  let value = Number.parseInt(String(input.value), 10);
  if (!Number.isFinite(value)) value = fallback;
  value = Math.max(min, Math.min(max, value));
  if (String(input.value) !== String(value)) input.value = String(value);
  return value;
}
function batchParallelism() {
  return clampParallelismInput("batchParallelismInput", 1, 30, 4);
}
function validationParallelism() {
  return clampParallelismInput("validationParallelismInput", 1, 15, 2);
}
var CLEAN_VALIDATION_TYPES = ["preclean", "postclean", "wacclean", "dummy", "dummywac"];
function cleanValidationTypes() {
  return CLEAN_VALIDATION_TYPES.filter((type) => document.getElementById(`cleanValidation${type[0].toUpperCase()}${type.slice(1)}Input`)?.checked === true);
}
var runSettingsPreferencesDirty = false;
function currentRunSettingsPreferences() {
  return {
    compatibilityMode: compatibilityModeEnabled(),
    hongYeCheck: hongYeCheckEnabled(),
    skipBaseline: skipBaselineEnabled(),
    executionTimingEnabled: executionTimingEnabled(),
    maximumWorkers: batchParallelism(),
    validationWorkers: validationParallelism(),
    cleanValidationTypes: cleanValidationTypes()
  };
}
function applyRunSettingsPreferences(settings) {
  if (!settings || typeof settings !== "object") return;
  const checkboxFields = {
    compatibilityMode: "compatibilityModeInput",
    hongYeCheck: "hongYeCheckInput",
    skipBaseline: "skipBaselineInput",
    executionTimingEnabled: "executionTimingEnabledInput"
  };
  Object.entries(checkboxFields).forEach(([field, elementId]) => {
    const input = document.getElementById(elementId);
    if (input && typeof settings[field] === "boolean") input.checked = settings[field];
  });
  const maximumWorkersInput = document.getElementById("batchParallelismInput");
  const validationWorkersInput = document.getElementById("validationParallelismInput");
  if (maximumWorkersInput) maximumWorkersInput.value = String(settings.maximumWorkers ?? 4);
  if (validationWorkersInput) validationWorkersInput.value = String(settings.validationWorkers ?? 2);
  const enabledCleanTypes = new Set(Array.isArray(settings.cleanValidationTypes) ? settings.cleanValidationTypes : CLEAN_VALIDATION_TYPES);
  CLEAN_VALIDATION_TYPES.forEach((type) => {
    const input = document.getElementById(`cleanValidation${type[0].toUpperCase()}${type.slice(1)}Input`);
    if (input) input.checked = enabledCleanTypes.has(type);
  });
  batchParallelism();
  validationParallelism();
  runSettingsPreferencesDirty = false;
  updateRunSettingsButtonLabel();
}
async function loadRunSettingsPreferences() {
  const result = await requestJson("/api/preferences/run-settings", { cache: "no-store" });
  if (!runSettingsPreferencesDirty) applyRunSettingsPreferences(result.runSettings);
}
async function saveRunSettingsPreferences() {
  const result = await requestJson("/api/preferences/run-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runSettings: currentRunSettingsPreferences() })
  });
  applyRunSettingsPreferences(result.runSettings);
}
function currentAnalysisSettingsPreferences() {
  return {
    metricIds: [...document.querySelectorAll("[data-analysis-metric]:checked")].map((input) => String(input.value)),
    windowMode: String(document.getElementById("analysisWindowMode")?.value || "steady"),
    timeBudgetSeconds: Number(document.getElementById("analysisTimeBudget")?.value || 120)
  };
}
function applyAnalysisSettingsPreferences(settings) {
  if (!settings || typeof settings !== "object") return;
  const selectedIds = new Set(Array.isArray(settings.metricIds) ? settings.metricIds : []);
  document.querySelectorAll("[data-analysis-metric]").forEach((input) => {
    input.checked = selectedIds.has(String(input.value));
  });
  const windowInput = document.getElementById("analysisWindowMode");
  const budgetInput = document.getElementById("analysisTimeBudget");
  if (windowInput && ["steady", "full"].includes(String(settings.windowMode))) {
    windowInput.value = String(settings.windowMode);
  }
  if (budgetInput && [30, 120, 300].includes(Number(settings.timeBudgetSeconds))) {
    budgetInput.value = String(settings.timeBudgetSeconds);
  }
  analysisSettingsPreferencesDirty = false;
}
async function loadAnalysisSettingsPreferences() {
  const result = await requestJson("/api/preferences/analysis-settings", { cache: "no-store" });
  if (!analysisSettingsPreferencesDirty) applyAnalysisSettingsPreferences(result.analysisSettings);
}
async function saveAnalysisSettingsPreferences() {
  const result = await requestJson("/api/preferences/analysis-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ analysisSettings: currentAnalysisSettingsPreferences() })
  });
  applyAnalysisSettingsPreferences(result.analysisSettings);
}
function hongYeCheckEnabled() {
  return document.getElementById("hongYeCheckInput")?.checked === true;
}
function executionTimingEnabled() {
  return compatibilityModeEnabled() && document.getElementById("executionTimingEnabledInput")?.checked === true;
}
var runSettingsTrigger = null;
function updateRunSettingsButtonLabel() {
  const button = document.getElementById("openRunSettingsButton");
  if (!button) return;
  const compatibility = document.getElementById("compatibilityModeInput")?.checked === true;
  const hongYe = document.getElementById("hongYeCheckInput")?.checked === true;
  const skipBaseline = document.getElementById("skipBaselineInput")?.checked === true;
  const executionTiming = document.getElementById("executionTimingEnabledInput")?.checked === true;
  const algorithmWorkers = batchParallelism();
  const validationWorkers = validationParallelism();
  const enabledCleanTypes = cleanValidationTypes();
  const validationInput = document.getElementById("validationParallelismInput");
  if (validationInput) validationInput.disabled = !hongYe;
  const executionInput = document.getElementById("executionTimingEnabledInput");
  if (executionInput) executionInput.disabled = !compatibility;
  const labels = [compatibility && "\u517C\u5BB9\u6A21\u5F0F", executionTiming && compatibility && "\u6267\u884C\u65F6\u95F4\u6A21\u62DF", hongYe && "HongYe Check", skipBaseline && "\u8DF3\u8FC7 Baseline", enabledCleanTypes.length !== CLEAN_VALIDATION_TYPES.length && `Clean \u6821\u9A8C ${enabledCleanTypes.length}/${CLEAN_VALIDATION_TYPES.length}`].filter(Boolean);
  const parallelism = `\u7B97\u6CD5\xD7${algorithmWorkers}${hongYe ? ` \u6821\u9A8C\xD7${validationWorkers}` : ""}`;
  const summary = labels.length ? `\u8FD0\u884C\u8BBE\u7F6E\uFF1A${labels.join("\u3001")}\uFF08${parallelism}\uFF09` : `\u8FD0\u884C\u8BBE\u7F6E\uFF1A${parallelism}`;
  button.setAttribute("aria-label", summary);
  button.setAttribute("title", summary);
  button.classList.toggle(
    "is-customized",
    !compatibility || executionTiming || !hongYe || !skipBaseline || algorithmWorkers !== 4 || validationWorkers !== 2 || enabledCleanTypes.length !== CLEAN_VALIDATION_TYPES.length
  );
}
function openRunSettingsDialog() {
  const dialog = document.getElementById("runSettingsDialog");
  runSettingsTrigger = document.getElementById("openRunSettingsButton");
  runSettingsTrigger?.setAttribute("aria-expanded", "true");
  dialog.showModal();
  window.setTimeout(() => document.getElementById("compatibilityModeInput")?.focus(), 0);
}
function closeRunSettingsDialog() {
  const dialog = document.getElementById("runSettingsDialog");
  if (dialog?.open) dialog.close();
}
function finishRunSettingsDialog() {
  updateRunSettingsButtonLabel();
  if (runSettingsPreferencesDirty) {
    saveRunSettingsPreferences().catch((error) => {
      runSettingsPreferencesDirty = true;
      writeTerminal(`$ \u8FD0\u884C\u8BBE\u7F6E\u4FDD\u5B58\u5931\u8D25
  ${error.message || "\u672A\u77E5\u9519\u8BEF"}`, true);
    });
  }
  runSettingsTrigger?.setAttribute("aria-expanded", "false");
  if (runSettingsTrigger?.isConnected) runSettingsTrigger.focus();
  runSettingsTrigger = null;
}
function compatibilityModeEnabled() {
  return document.getElementById("compatibilityModeInput")?.checked === true;
}
function skipBaselineEnabled() {
  return document.getElementById("skipBaselineInput")?.checked === true;
}
function validationDisplay(value) {
  if (value === "passed") return "\u901A\u8FC7";
  if (value === "skipped") return "\u8DF3\u8FC7";
  return value ? String(value) : "";
}
function renderOtherAlgorithmOptions(algorithms) {
  state.availableAlgorithms = Array.isArray(algorithms) ? algorithms : [];
  const container = document.getElementById("otherAlgorithmOptions");
  container.innerHTML = state.availableAlgorithms.map((algorithm) => `
    <label class="strategy-card" data-strategy-card="${escapeHtml3(algorithm.strategy)}" ${algorithm.unavailableReason ? `title="${escapeHtml3(algorithm.unavailableReason)}"` : ""}>
      <input type="radio" name="strategy" value="${escapeHtml3(algorithm.strategy)}" ${algorithm.strategy === state.strategy ? "checked" : ""} ${algorithm.available === false ? "disabled" : ""}>
      <b>${escapeHtml3(algorithm.name)}</b>
    </label>
  `).join("");
  updateStrategyOptionVisibility();
  renderAlgorithmMetadata();
}
function updateStrategyOptionVisibility() {
  const algorithm = state.availableAlgorithms.find((item) => item.strategy === state.strategy);
  const optionGroups = new Set(algorithm?.optionGroups || []);
  document.getElementById("loadlockOptions").classList.toggle("is-hidden", !optionGroups.has("loadlock"));
  document.getElementById("heuristicSettings").classList.toggle("is-hidden", state.strategy !== "heuristic");
  document.getElementById("searchTreeOptions").classList.toggle("is-hidden", !optionGroups.has("search-tree"));
}
function showAlgorithmDetails(strategy) {
  const metadata = state.algorithmMetadata[strategy] || {};
  const cardName = document.querySelector(`[data-strategy-card="${CSS.escape(strategy)}"] b`)?.textContent;
  document.getElementById("algorithmHoverInfo").innerHTML = `
    <span class="algorithm-hover-info-name">${escapeHtml3(metadata.name || cardName || strategy)}<small>\u7B97\u6CD5\u7B80\u4ECB</small></span>
    <span class="algorithm-hover-info-description">${escapeHtml3(metadata.introduction || "\u6682\u65E0\u7B97\u6CD5\u7B80\u4ECB")}</span>
  `;
}
function displayStrategyName(strategy) {
  const normalized = String(strategy || "heuristic");
  const cardName = document.querySelector(`[data-strategy-card="${CSS.escape(normalized)}"] b`)?.textContent;
  return state.algorithmMetadata[normalized]?.name || cardName || normalized;
}
function renderAlgorithmMetadata() {
  document.querySelectorAll("[data-strategy-card]").forEach((card) => {
    const strategy = card.dataset.strategyCard;
    card.onmouseenter = () => showAlgorithmDetails(strategy);
    card.onfocusin = () => showAlgorithmDetails(strategy);
  });
  const strategyOptions = document.querySelector(".strategy-options");
  strategyOptions.onmouseleave = () => showAlgorithmDetails(state.strategy);
  strategyOptions.onfocusout = (event) => {
    if (!strategyOptions.contains(event.relatedTarget)) showAlgorithmDetails(state.strategy);
  };
  showAlgorithmDetails(state.strategy);
}
function readableLogFileName(testName) {
  const readableTestName = String(testName || "\u5F53\u524D\u6D4B\u8BD5").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/^[ ._]+|[ ._]+$/g, "") || "\u5F53\u524D\u6D4B\u8BD5";
  return `\u590D\u73B0\u65E5\u5FD7-${readableTestName}.json`;
}
function prepareLogDownload(result) {
  if (!result?.logUrl) return false;
  const link = document.getElementById("logButton");
  link.href = result.logUrl;
  link.download = readableLogFileName(state.testCaseName);
  link.removeAttribute("aria-disabled");
  return true;
}
function prepareGanttView(result) {
  if (!result?.ganttUrl) return false;
  const link = document.getElementById("ganttButton");
  link.href = result.ganttUrl;
  link.removeAttribute("aria-disabled");
  return true;
}
async function prepareWorkspaceView(result) {
  if (!result?.resultId) return null;
  visualizationWorkspace.setAnalysisConfiguration(state.routes, state.rounds);
  visualizationWorkspace.setReplayPlan(buildPayload());
  await visualizationWorkspace.loadResult(result.resultId, state.testCaseName || "\u5F53\u524D\u8FD0\u884C\u7ED3\u679C");
  const replayDeadlock = visualizationWorkspace.getTerminalDeadlock();
  if (result.deadlock) {
    const serverCode = String(result.deadlock.Code || "").toUpperCase();
    result.deadlock = replayDeadlock || (DEADLOCK_TYPE_CATALOG[serverCode] ? result.deadlock : { Code: "DEADLOCK.UNCLASSIFIED" });
  }
  return visualizationWorkspace.getBottleneckUtilization();
}
function formatRunElapsed(milliseconds) {
  const totalTenths = Math.max(0, Math.floor(Number(milliseconds || 0) / 100));
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor(totalTenths / 10) % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${totalTenths % 10}`;
}
function startRunStatus(title, initialLabel = "\u6B63\u5728\u51C6\u5907") {
  const card = document.getElementById("runStatusCard");
  card.classList.remove("failed", "cancelled");
  card.classList.add("running");
  document.getElementById("runStatusTitle").textContent = title;
  runStatusStartedAt = performance.now();
  runStatusElapsedMs = 0;
  renderRunStatusEvents([{ label: initialLabel, status: "running" }]);
  window.clearInterval(runStatusTimer);
  runStatusTimer = window.setInterval(() => {
    runStatusElapsedMs = Math.max(runStatusElapsedMs, performance.now() - runStatusStartedAt);
    document.getElementById("runStatusElapsed").textContent = formatRunElapsed(runStatusElapsedMs);
  }, 100);
}
function renderRunStatusEvents(events) {
  const root = document.getElementById("runStatusEvents");
  const visible = Array.isArray(events) ? events.slice(-6) : [];
  root.replaceChildren(...visible.map((event) => {
    const item = document.createElement("span");
    item.className = `run-status-event ${String(event.status || "")}`;
    const suffix = event.status === "succeeded" ? String(event.label || "").startsWith("\u6536\u5230 ") ? "" : " \u6210\u529F" : event.status === "failed" ? " \u5931\u8D25" : event.status === "running" ? "\u2026" : event.status === "cancelled" ? " \u5DF2\u505C\u6B62" : "";
    item.textContent = `${event.label || "\u5904\u7406\u4E2D"}${suffix}`;
    if (event.detail) item.title = String(event.detail);
    return item;
  }));
}
function renderSingleRunStatus(snapshot) {
  if (!snapshot) return;
  runStatusElapsedMs = Math.max(runStatusElapsedMs, Number(snapshot.elapsedMs || 0));
  document.getElementById("runStatusElapsed").textContent = formatRunElapsed(runStatusElapsedMs);
  const terminal = ["completed", "failed", "cancelled"].includes(snapshot.status);
  const title = snapshot.status === "completed" ? "\u5F53\u524D\u6D4B\u8BD5\u8FD0\u884C\u5B8C\u6210" : snapshot.status === "failed" ? "\u5F53\u524D\u6D4B\u8BD5\u8FD0\u884C\u5931\u8D25" : snapshot.status === "cancelled" ? "\u5F53\u524D\u6D4B\u8BD5\u5DF2\u505C\u6B62" : `\u6B63\u5728\u8FD0\u884C \xB7 ${snapshot.testName || state.testCaseName || "\u5F53\u524D\u6D4B\u8BD5"}`;
  document.getElementById("runStatusTitle").textContent = title;
  renderRunStatusEvents(snapshot.events || []);
  if (terminal) finishRunStatus(snapshot.status, title);
}
function renderBatchRunStatus(result) {
  if (!result) return;
  const total = Number(result.testCount || 0);
  const completed = Number(result.completed || 0);
  const running = (result.items || []).filter((item) => item.status === "running").length;
  renderRunStatusEvents([
    { label: `\u5B8C\u6210 ${completed}/${total}`, status: completed === total && total ? "succeeded" : "running" },
    { label: `\u8FD0\u884C\u4E2D ${running}`, status: running ? "running" : "skipped" },
    { label: `\u6210\u529F ${Number(result.succeeded || 0)}`, status: "succeeded" },
    ...Number(result.failed || 0) ? [{ label: `\u5931\u8D25 ${Number(result.failed)}`, status: "failed" }] : []
  ]);
  document.getElementById("runStatusTitle").textContent = `\u6279\u91CF\u6D4B\u8BD5 \xB7 ${state.activeTestGroup || "\u672A\u5206\u7EC4"}`;
}
function finishRunStatus(status, title) {
  window.clearInterval(runStatusTimer);
  runStatusTimer = 0;
  if (runStatusStartedAt) runStatusElapsedMs = Math.max(runStatusElapsedMs, performance.now() - runStatusStartedAt);
  document.getElementById("runStatusElapsed").textContent = formatRunElapsed(runStatusElapsedMs);
  const card = document.getElementById("runStatusCard");
  card.classList.remove("running", "failed", "cancelled");
  if (status === "failed") card.classList.add("failed");
  if (status === "cancelled") card.classList.add("cancelled");
  if (title) document.getElementById("runStatusTitle").textContent = title;
}
async function pollSingleRunStatus(runId) {
  while (singleRunActive && activeSingleRunId === runId) {
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, { cache: "no-store" });
      if (response.ok) {
        const snapshot = await response.json();
        renderSingleRunStatus(snapshot);
        if (["completed", "failed", "cancelled"].includes(snapshot.status)) return;
      }
    } catch {
    }
    await new Promise((resolve) => window.setTimeout(resolve, 180));
  }
}
async function requestSingleRunCancellation() {
  if (!singleRunActive || singleRunCancelling || !activeSingleRunId) return;
  singleRunCancelling = true;
  const button = document.getElementById("runButton");
  button.disabled = true;
  button.classList.add("running", "cancel");
  button.textContent = "\u6B63\u5728\u505C\u6B62\u2026";
  document.getElementById("runStatusTitle").textContent = "\u6B63\u5728\u505C\u6B62\u5F53\u524D\u6D4B\u8BD5";
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(activeSingleRunId)}`, { method: "DELETE" });
    const snapshot = await response.json();
    if (!response.ok) throw new Error(snapshot.error || `\u670D\u52A1\u8FD4\u56DE ${response.status}`);
    renderSingleRunStatus(snapshot);
    if (state.strategy === "search-tree") {
      try {
        await requestSearchControl("cancel");
      } catch {
      }
    }
    singleRunAbortController?.abort();
  } catch (error) {
    singleRunCancelling = false;
    button.disabled = false;
    button.classList.remove("running");
    button.classList.add("cancel");
    button.textContent = "\u25A0 \u505C\u6B62\u5F53\u524D\u6D4B\u8BD5";
    throw error;
  }
}
async function runPlan() {
  const button = document.getElementById("runButton");
  const batchButton = document.getElementById("batchRunButton");
  if (singleRunActive) {
    try {
      await requestSingleRunCancellation();
    } catch (error) {
      writeTerminal(`$ \u505C\u6B62\u5931\u8D25\uFF1A${error.message || "\u672A\u77E5\u9519\u8BEF"}
  \u53EF\u518D\u6B21\u70B9\u51FB\u201C\u25A0 \u505C\u6B62\u5F53\u524D\u6D4B\u8BD5\u201D\u91CD\u8BD5\u3002`, true);
    }
    return;
  }
  let logReady = false, ganttReady = false, runResult = null, bottleneckSummary = null;
  button.disabled = true;
  batchButton.disabled = true;
  button.classList.add("running");
  button.classList.remove("cancel");
  button.textContent = "\u6B63\u5728\u51C6\u5907\u2026";
  startRunStatus(`\u51C6\u5907\u8FD0\u884C \xB7 ${state.testCaseName || "\u5F53\u524D\u6D4B\u8BD5"}`, "\u68C0\u67E5\u670D\u52A1\u4E0E\u6D4B\u8BD5\u914D\u7F6E");
  try {
    const healthResponse = await fetch("/api/health", { cache: "no-store" }), health = await healthResponse.json();
    if (!healthResponse.ok || health.schemaVersion !== EXPECTED_API_SCHEMA) throw new Error("\u672C\u5730\u670D\u52A1\u7248\u672C\u8FC7\u65E7\uFF0C\u8BF7\u91CD\u542F realtime_scheduler.backend.main");
    if (state.strategy.startsWith("other_alg:")) {
      const algorithm = (health.otherAlgorithms || []).find((item) => item.strategy === state.strategy);
      if (!algorithm?.available) throw new Error(`${state.strategy} \u7B97\u6CD5\u5305\u4E0D\u5B58\u5728\u6216\u5165\u53E3\u4E0D\u5B8C\u6574`);
    } else if (health.strategies?.[state.strategy] === false) {
      throw new Error(health.strategyErrors?.[state.strategy] || `${state.strategy} \u7B56\u7565\u5F53\u524D\u4E0D\u53EF\u7528`);
    }
    if (state.dirty) await saveCurrentTest(true);
    const payload = buildPayload();
    const runId = (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9_-]/g, "");
    payload.clientRunId = runId;
    payload.testCaseName = state.testCaseName || "\u5F53\u524D\u6D4B\u8BD5";
    singleRunActive = true;
    singleRunCancelling = false;
    activeSingleRunId = runId;
    singleRunAbortController = new AbortController();
    button.disabled = false;
    batchButton.disabled = true;
    button.classList.remove("running");
    button.classList.add("cancel");
    button.textContent = "\u25A0 \u505C\u6B62\u5F53\u524D\u6D4B\u8BD5";
    startRunStatus(`\u6B63\u5728\u8FD0\u884C \xB7 ${payload.testCaseName}`, "\u63D0\u4EA4\u8FD0\u884C\u8BF7\u6C42");
    void pollSingleRunStatus(runId);
    resetRunResult();
    visualizationWorkspace.setAnalysisConfiguration(state.routes, state.rounds);
    writeTerminal(`$ \u5F00\u59CB\u8FD0\u884C ${state.strategy}
  \u603B\u8F6E\u6570: ${state.roundCount}
  \u91CD\u7B97\u65F6\u95F4: ${state.rounds.map((round) => round.currentTime).join(", ")} s`);
    const response = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: singleRunAbortController.signal
    });
    const responseText = await response.text();
    try {
      runResult = JSON.parse(responseText);
    } catch {
      throw new Error(responseText.trim().slice(0, 240) || `\u670D\u52A1\u8FD4\u56DE ${response.status}`);
    }
    logReady = prepareLogDownload(runResult);
    ganttReady = prepareGanttView(runResult);
    if (runResult?.resultId) {
      try {
        bottleneckSummary = await prepareWorkspaceView(runResult);
        runResult.bottleneckUtilization = bottleneckSummary;
      } catch (workspaceError) {
        writeTerminal(`$ \u5DE5\u4F5C\u53F0\u52A0\u8F7D\u5931\u8D25
  ${workspaceError.message || "\u672A\u77E5\u9519\u8BEF"}`, true);
      }
    }
    if (!response.ok || !runResult.ok) {
      if (runResult?.metricsAvailable) showFailedResultMetrics(runResult);
      throw new Error(runResult.error || `\u670D\u52A1\u8FD4\u56DE ${response.status}`);
    }
    showResult(runResult);
    finishRunStatus("completed", "\u5F53\u524D\u6D4B\u8BD5\u8FD0\u884C\u5B8C\u6210");
  } catch (error) {
    const cancelled = singleRunCancelling || runResult?.cancelled === true || error?.name === "AbortError";
    const baselineError = runResult?.baseline?.status === "failed" ? `
  Baseline \u5931\u8D25\uFF1A${runResult.baseline.error || "\u672A\u77E5\u539F\u56E0"}` : "";
    const validationIssues = Array.isArray(runResult?.validationIssues) ? runResult.validationIssues.map((issue) => `  ${issue}`) : [];
    const deadlock = deadlockDisplay(runResult?.deadlock);
    if (!runResult?.metricsAvailable && ganttReady) {
      setBottleneckMetric(bottleneckSummary, "\u6CA1\u6709\u8DB3\u591F\u7684\u8D44\u6E90\u6D3B\u52A8");
      document.getElementById("metricMakespan").textContent = Number.isFinite(Number(runResult.makespan)) ? `${Number(runResult.makespan).toFixed(2)} s` : "\u2014";
    }
    renderRunFailureCard({
      cancelled,
      errorMessage: error.message || "\u672A\u77E5\u9519\u8BEF",
      deadlock,
      validationIssues,
      baselineError: baselineError.trim()
    });
    document.getElementById("metricValidation").textContent = runResult?.metricsAvailable ? runResult.validation === "failed" ? "\u672A\u901A\u8FC7" : validationDisplay(runResult.validation) || "\u5931\u8D25" : "\u5931\u8D25";
    finishRunStatus(cancelled ? "cancelled" : "failed", cancelled ? "\u5F53\u524D\u6D4B\u8BD5\u5DF2\u505C\u6B62" : "\u5F53\u524D\u6D4B\u8BD5\u8FD0\u884C\u5931\u8D25");
  } finally {
    singleRunActive = false;
    singleRunCancelling = false;
    activeSingleRunId = "";
    singleRunAbortController = null;
    button.disabled = false;
    button.classList.remove("running", "cancel");
    button.textContent = "\u25B6 \u8FD0\u884C\u5F53\u524D\u6D4B\u8BD5";
    renderWorkspaceControls();
  }
}
function currentBatchGroupTests() {
  return (state.workspaceDevice?.tests || []).map((test, workspaceIndex) => ({ test, workspaceIndex })).filter(({ test }) => String(test.group || "").trim() === state.activeTestGroup).sort((left, right) => {
    const leftLabel = String(left.test.name || left.test.id || "");
    const rightLabel = String(right.test.name || right.test.id || "");
    return TEST_ORDER_COLLATOR.compare(leftLabel, rightLabel) || left.workspaceIndex - right.workspaceIndex;
  }).map(({ test }) => test);
}
function updateBatchSelectionCount() {
  const checkboxes = [...document.querySelectorAll("[data-batch-test-selection]")];
  const selectedCount = checkboxes.filter((checkbox) => checkbox.checked).length;
  document.getElementById("batchSelectionCount").textContent = `\u5DF2\u9009\u62E9 ${selectedCount}/${checkboxes.length} \u9879`;
  document.getElementById("batchSelectionRunSelected").disabled = selectedCount === 0;
}
function setBatchTestSelection(predicate) {
  document.querySelectorAll("[data-batch-test-selection]").forEach((checkbox, index) => {
    checkbox.checked = Boolean(predicate(index));
  });
  updateBatchSelectionCount();
}
function openBatchTestSelectionDialog() {
  if (!state.workspaceDeviceId) {
    writeTerminal("$ \u8BF7\u5148\u9009\u62E9\u8BBE\u5907\u548C\u6D4B\u8BD5\u7EC4", true);
    return;
  }
  const tests = currentBatchGroupTests();
  if (!tests.length) {
    writeTerminal("$ \u5F53\u524D\u6D4B\u8BD5\u7EC4\u6CA1\u6709\u53EF\u8FD0\u884C\u6D4B\u8BD5", true);
    return;
  }
  document.getElementById("batchTestSelectionDialogContext").textContent = `${state.activeTestGroup || "\u672A\u5206\u7EC4"} \xB7 \u5171 ${tests.length} \u9879 \xB7 \u5C06\u6309\u4E0B\u5217\u987A\u5E8F\u6267\u884C\u5E76\u5C55\u793A`;
  document.getElementById("batchSelectionList").innerHTML = tests.map((test, index) => `
    <label class="batch-selection-item" title="${escapeHtml3(`${test.id || ""} \xB7 ${test.name || ""}`)}">
      <input type="checkbox" value="${escapeHtml3(test.id || "")}" data-batch-test-selection checked>
      <span class="batch-selection-index">t${index + 1}</span>
      <span class="batch-selection-name">${escapeHtml3(test.name || `\u6D4B\u8BD5 ${index + 1}`)}</span>
    </label>
  `).join("");
  const rangeStart = document.getElementById("batchSelectionRangeStart");
  const rangeEnd = document.getElementById("batchSelectionRangeEnd");
  rangeStart.max = String(tests.length);
  rangeStart.value = "1";
  rangeEnd.max = String(tests.length);
  rangeEnd.value = String(tests.length);
  updateBatchSelectionCount();
  const dialog = document.getElementById("batchTestSelectionDialog");
  dialog.showModal();
  window.requestAnimationFrame(() => rangeStart.focus());
}
function runBatchSelection(runAll = false) {
  const tests = currentBatchGroupTests();
  const selectedIds = runAll ? tests.map((test) => String(test.id || "")) : [...document.querySelectorAll("[data-batch-test-selection]:checked")].map((checkbox) => String(checkbox.value));
  if (!selectedIds.length) return;
  document.getElementById("batchTestSelectionDialog").close();
  void runCurrentTestGroup(selectedIds);
}
async function runCurrentTestGroup(selectedTestIds = null) {
  const button = document.getElementById("batchRunButton");
  const runButton = document.getElementById("runButton");
  if (state.batchRunning) {
    try {
      await requestBatchCancellation();
    } catch (error) {
      state.batchCancelRequested = false;
      state.batchCancelSent = false;
      button.disabled = false;
      button.classList.remove("running");
      button.classList.add("cancel");
      button.textContent = "\u25A0 \u7EC8\u6B62\u8C03\u5EA6";
      writeTerminal(`$ \u7EC8\u6B62\u5931\u8D25\uFF1A${error.message || "\u672A\u77E5\u9519\u8BEF"}
  \u6279\u91CF\u4EFB\u52A1\u4ECD\u5728\u8FD0\u884C\uFF0C\u53EF\u518D\u6B21\u5C1D\u8BD5\u7EC8\u6B62\u3002`, true);
    }
    return;
  }
  if (!Array.isArray(selectedTestIds)) {
    openBatchTestSelectionDialog();
    return;
  }
  try {
    if (!state.workspaceDeviceId) throw new Error("\u8BF7\u5148\u9009\u62E9\u8BBE\u5907\u548C\u6D4B\u8BD5\u7EC4");
    if (state.dirty) await saveCurrentTest(true);
    const selectedIdSet = new Set(selectedTestIds.map(String));
    const tests = currentBatchGroupTests().filter((test) => selectedIdSet.has(String(test.id || "")));
    if (!tests.length) throw new Error("\u8BF7\u81F3\u5C11\u9009\u62E9\u4E00\u4E2A\u53EF\u8FD0\u884C\u6D4B\u8BD5");
    state.batchRunning = true;
    state.activeBatchId = "";
    state.batchCancelRequested = false;
    state.batchCancelSent = false;
    state.batchResult = null;
    state.selectedBatchTestId = "";
    startRunStatus(`\u6279\u91CF\u6D4B\u8BD5 \xB7 ${state.activeTestGroup || "\u672A\u5206\u7EC4"}`, `\u7B49\u5F85 ${tests.length} \u4E2A\u6D4B\u8BD5`);
    batchPerformanceAnalyses.clear();
    batchBottleneckSummaries.clear();
    batchBottleneckRequests.clear();
    batchBottleneckErrors.clear();
    batchCardAnalyses.clear();
    batchCardAnalysisRequests.clear();
    lastBatchItemsRenderSignature = "";
    document.getElementById("testGroupAnalysisButton").hidden = true;
    document.getElementById("testGroupAnalysisPanel").hidden = true;
    document.getElementById("testGroupAnalysisPanel").innerHTML = "";
    document.getElementById("batchOverviewButton").hidden = true;
    button.disabled = false;
    runButton.disabled = true;
    button.classList.add("cancel");
    button.textContent = "\u25A0 \u7EC8\u6B62\u8C03\u5EA6";
    document.getElementById("batchResults").innerHTML = "";
    const validationSummary = hongYeCheckEnabled() ? ` \xB7 HongYe \u6821\u9A8C\u5E76\u884C ${validationParallelism()} \u8DEF` : "";
    writeTerminal(`$ \u6279\u91CF\u8FD0\u884C\u5F53\u524D\u6D4B\u8BD5\u7EC4
  \u7EC4\u522B: ${state.activeTestGroup || "\u672A\u5206\u7EC4"}
  \u7B56\u7565: ${displayStrategyName(state.strategy)}
  \u6D4B\u8BD5\u6570: ${tests.length}
  \u7B97\u6CD5\u5E76\u884C ${batchParallelism()} \u9879${validationSummary}\u2026`);
    const response = await fetch("/api/run-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: state.workspaceDeviceId, group: state.activeTestGroup, testIds: tests.map((test) => test.id), strategy: state.strategy, options: schedulingRequestOptions(), hongYeCheck: hongYeCheckEnabled(), compatibilityMode: compatibilityModeEnabled(), executionTimingEnabled: executionTimingEnabled(), skipBaseline: skipBaselineEnabled(), maximumWorkers: batchParallelism(), validationWorkers: validationParallelism(), cleanValidationTypes: cleanValidationTypes() })
    });
    let result = await response.json();
    if (!response.ok || !result.batchId || !Array.isArray(result.items)) throw new Error(result.error || `\u670D\u52A1\u8FD4\u56DE ${response.status}`);
    state.activeBatchId = result.batchId;
    showBatchProgress(result);
    renderBatchRunStatus(result);
    if (state.batchCancelRequested) await sendBatchCancellation();
    while (!["completed", "failed", "cancelled"].includes(result.status)) {
      await new Promise((resolve) => window.setTimeout(resolve, BATCH_STATUS_POLL_MILLISECONDS));
      const statusResponse = await fetch(`/api/run-batches/${encodeURIComponent(result.batchId)}`, { cache: "no-store" });
      result = await statusResponse.json();
      if (!statusResponse.ok) throw new Error(result.error || `\u670D\u52A1\u8FD4\u56DE ${statusResponse.status}`);
      showBatchProgress(result);
      renderBatchRunStatus(result);
    }
    if (result.status === "cancelled") {
      showBatchProgress(result);
      writeTerminal(`$ \u6279\u91CF\u8C03\u5EA6\u5DF2\u7EC8\u6B62
  \u5DF2\u505C\u6B62\u63D0\u4EA4\u7B49\u5F85\u4E2D\u7684\u6D4B\u8BD5\uFF1B\u4ECD\u5728\u7B97\u6CD5\u5185\u90E8\u6267\u884C\u7684\u4EFB\u52A1\u7ED3\u679C\u5C06\u88AB\u5FFD\u7565\u3002`);
      finishRunStatus("cancelled", "\u6279\u91CF\u6D4B\u8BD5\u5DF2\u505C\u6B62");
      return;
    }
    if (result.status === "failed" && !Array.isArray(result.items)) throw new Error(result.error || "\u6279\u91CF\u4EFB\u52A1\u5931\u8D25");
    showBatchResult(result);
    finishRunStatus(Number(result.failed || 0) ? "failed" : "completed", Number(result.failed || 0) ? "\u6279\u91CF\u6D4B\u8BD5\u5B8C\u6210\uFF08\u6709\u5931\u8D25\uFF09" : "\u6279\u91CF\u6D4B\u8BD5\u8FD0\u884C\u5B8C\u6210");
  } catch (error) {
    writeTerminal(`$ \u6279\u91CF\u8FD0\u884C\u5931\u8D25\uFF1A${error.message || "\u672A\u77E5\u9519\u8BEF"}`, true);
    document.getElementById("metricValidation").textContent = "\u5931\u8D25";
    finishRunStatus("failed", "\u6279\u91CF\u6D4B\u8BD5\u8FD0\u884C\u5931\u8D25");
  } finally {
    state.batchRunning = false;
    state.activeBatchId = "";
    state.batchCancelRequested = false;
    state.batchCancelSent = false;
    button.disabled = !state.serviceCompatible;
    runButton.disabled = !state.serviceCompatible;
    button.classList.remove("running", "cancel");
    button.textContent = "\u25A6 \u8FD0\u884C\u5F53\u524D\u6D4B\u8BD5\u7EC4";
    renderWorkspaceControls();
  }
}
async function requestBatchCancellation() {
  if (!state.batchRunning || state.batchCancelRequested) return;
  state.batchCancelRequested = true;
  const button = document.getElementById("batchRunButton");
  button.disabled = true;
  button.classList.add("running");
  button.textContent = "\u6B63\u5728\u7EC8\u6B62\u2026";
  writeTerminal("$ \u6B63\u5728\u7EC8\u6B62\u6279\u91CF\u8C03\u5EA6\u2026");
  if (state.activeBatchId) await sendBatchCancellation();
}
async function sendBatchCancellation() {
  if (!state.activeBatchId || state.batchCancelSent) return;
  state.batchCancelSent = true;
  const response = await fetch(`/api/run-batches/${encodeURIComponent(state.activeBatchId)}`, { method: "DELETE" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `\u7EC8\u6B62\u5931\u8D25\uFF0C\u670D\u52A1\u8FD4\u56DE ${response.status}`);
  showBatchProgress(result);
}
function setResultMetric(key, label, value, detail = "") {
  document.getElementById(`metric${key}Label`).textContent = label;
  document.getElementById(`metric${key}`).textContent = value;
  document.getElementById(`metric${key}Detail`).textContent = detail;
}
function hasBatchResultMetrics(item) {
  return item?.status === "succeeded" || item?.metricsAvailable === true;
}
function setBottleneckMetric(summary, emptyDetail = "") {
  const utilization = Number(summary?.utilization);
  const available = summary && Number.isFinite(utilization);
  const resourceName = String(summary?.resourceName || "\u672A\u77E5\u8D44\u6E90").replace(/^工序容量组\s*[·:：-]?\s*/, "").trim() || "\u672A\u77E5\u8D44\u6E90";
  setResultMetric(
    "Moves",
    "Bottleneck Utilization",
    available ? `${resourceName} ${(utilization * 100).toFixed(1)}%` : "\u2014",
    available ? "" : emptyDetail
  );
}
function showBatchOverviewMetrics(result) {
  const measured = (result.items || []).filter(hasBatchResultMetrics);
  const averageMakespan = measured.length ? measured.reduce((sum, item) => sum + Number(item.makespan), 0) / measured.length : 0;
  const comparable = measured.filter((item) => item.baseline?.status === "succeeded");
  const totalMakespan = comparable.reduce((sum, item) => sum + Number(item.makespan), 0);
  const totalBaseline = comparable.reduce((sum, item) => sum + Number(item.baseline.makespan), 0);
  const aggregateImprovement = totalBaseline > 0 ? (totalBaseline - totalMakespan) / totalBaseline * 100 : NaN;
  const moveCount = measured.reduce((sum, item) => sum + Number(item.moveCount || 0), 0);
  const timeText = result.status === "completed" ? `${(Number(result.totalElapsedMs) / 1e3).toFixed(2)} s` : result.status === "cancelled" ? "\u5DF2\u7EC8\u6B62" : "\u8FD0\u884C\u4E2D";
  const makespanText = comparable.length ? `${totalMakespan.toFixed(2)} / ${totalBaseline.toFixed(2)} s` : measured.length ? `${averageMakespan.toFixed(2)} s` : "\u2014";
  const improvementText = comparable.length && Number.isFinite(aggregateImprovement) ? `${aggregateImprovement >= 0 ? "\u63D0\u5347" : "\u9000\u5316"} ${Math.abs(aggregateImprovement).toFixed(2)}%` : "";
  document.getElementById("metricContext").textContent = `\u6279\u91CF\u603B\u89C8 \xB7 ${result.group || "\u672A\u5206\u7EC4"}`;
  document.getElementById("batchOverviewButton").hidden = true;
  setResultMetric("Time", "Total Time", timeText);
  setResultMetric("Makespan", comparable.length ? "\u603B Makespan / Baseline" : "\u5E73\u5747 Makespan", makespanText, improvementText);
  setResultMetric("Moves", "\u603B Move \u6570", moveCount || "\u2014");
  setResultMetric("Validation", result.cancelled ? "\u6210\u529F / \u5931\u8D25 / \u7EC8\u6B62" : "\u6210\u529F / \u5931\u8D25", result.cancelled ? `${result.succeeded || 0} / ${result.failed || 0} / ${result.cancelled}` : `${result.succeeded || 0} / ${result.failed || 0}`);
}
function showBatchItemOverview(item, index) {
  const hasMetrics = hasBatchResultMetrics(item);
  const baseline = item.baseline || {};
  const baselineReady = baseline.status === "succeeded";
  const cpuTime = Number(item.cpuTimeMs ?? item.totalElapsedMs);
  const elapsedTime = Number(item.totalElapsedMs);
  const makespan = Number(item.makespan);
  const improvement = Number(item.improvementPercent);
  const validationText = item.validation === "passed" ? "\u901A\u8FC7" : item.validation === "skipped" ? "\u8DF3\u8FC7" : item.validation ? String(item.validation) : item.status === "failed" ? "\u8FD0\u884C\u5931\u8D25" : item.status === "cancelled" ? "\u5DF2\u7EC8\u6B62" : "\u7B49\u5F85\u5B8C\u6210";
  const comparisonDetail = baselineReady && Number.isFinite(improvement) ? `${improvement >= 0 ? "\u63D0\u5347" : "\u9000\u5316"} ${Math.abs(improvement).toFixed(2)}%` : baseline.status && baseline.status !== "succeeded" && baseline.status !== "skipped" ? `Baseline ${baseline.status === "failed" ? "\u5931\u8D25" : "\u5931\u6548"}` : "";
  const resultUrl = String(item.resultUrl || "");
  const bottleneckReady = resultUrl && batchBottleneckSummaries.has(resultUrl);
  const bottleneckSummary = bottleneckReady ? batchBottleneckSummaries.get(resultUrl) : null;
  const bottleneckError = resultUrl ? batchBottleneckErrors.get(resultUrl) : "";
  document.getElementById("metricContext").textContent = `t${index + 1} \xB7 ${item.testName || `\u6D4B\u8BD5 ${index + 1}`} \xB7 ${displayStrategyName(state.batchResult?.strategy)}`;
  document.getElementById("batchOverviewButton").hidden = false;
  setResultMetric("Time", "CPU Time / \u8017\u65F6", Number.isFinite(cpuTime) ? `${cpuTime.toFixed(1)} ms` : "\u2014", Number.isFinite(elapsedTime) ? `\u7AEF\u5230\u7AEF\u8017\u65F6 ${elapsedTime.toFixed(1)} ms` : "");
  setResultMetric("Makespan", "Makespan / Baseline", Number.isFinite(makespan) ? `${makespan.toFixed(2)} / ${baselineReady ? Number(baseline.makespan).toFixed(2) : "\u2014"} s` : "\u2014", comparisonDetail);
  setBottleneckMetric(
    bottleneckSummary,
    hasMetrics && resultUrl ? bottleneckError ? `\u74F6\u9888\u8BA1\u7B97\u5931\u8D25\uFF1A${bottleneckError}` : bottleneckReady ? "\u6CA1\u6709\u8DB3\u591F\u7684\u8D44\u6E90\u6D3B\u52A8" : "\u6B63\u5728\u8BA1\u7B97\u7A33\u6001\u74F6\u9888\u2026" : "\u6CA1\u6709\u53EF\u5206\u6790\u7684 MoveList"
  );
  setResultMetric("Validation", "Validation", validationText, item.error || "");
}
async function loadBatchItemPerformance(item, index) {
  const resultUrl = String(item?.resultUrl || "");
  if (!resultUrl || !hasBatchResultMetrics(item)) return null;
  if (batchPerformanceAnalyses.has(resultUrl)) {
    return batchPerformanceAnalyses.get(resultUrl);
  }
  if (batchBottleneckErrors.has(resultUrl)) return null;
  let request = batchBottleneckRequests.get(resultUrl);
  if (!request) {
    request = (async () => {
      const testCase = (state.workspaceDevice?.tests || []).find(
        (test) => String(test.id) === String(item.testId)
      );
      const resultId = resultUrl.startsWith("/api/results/") ? decodeURIComponent(resultUrl.slice("/api/results/".length)) : "";
      if (!resultId) throw new Error("\u7ED3\u679C\u5730\u5740\u4E0D\u7B26\u5408\u670D\u52A1\u7AEF\u5206\u6790\u5951\u7EA6");
      const response = await requestScheduleAnalysis({
        resultId,
        device: state.device,
        windowMode: "steady",
        routes: state.workspaceDevice?.routes || state.routes,
        rounds: testCase?.rounds || state.rounds
      });
      batchPerformanceAnalyses.set(resultUrl, response.analysis);
      batchBottleneckSummaries.set(resultUrl, response.bottleneck);
      return response.analysis;
    })();
    batchBottleneckRequests.set(resultUrl, request);
  }
  try {
    return await request;
  } catch (error) {
    batchBottleneckErrors.set(resultUrl, error.message || "\u672A\u77E5\u9519\u8BEF");
    if (state.selectedBatchTestId === String(item.testId || `index-${index}`)) {
      setBottleneckMetric(null, `\u74F6\u9888\u8BA1\u7B97\u5931\u8D25\uFF1A${error.message || "\u672A\u77E5\u9519\u8BEF"}`);
    }
    return null;
  } finally {
    batchBottleneckRequests.delete(resultUrl);
  }
}
async function loadBatchItemBottleneck(item, index) {
  await loadBatchItemPerformance(item, index);
  const currentIndex = (state.batchResult?.items || []).findIndex(
    (candidate, candidateIndex) => String(candidate.testId || `index-${candidateIndex}`) === state.selectedBatchTestId
  );
  if (currentIndex >= 0) showBatchItemOverview(state.batchResult.items[currentIndex], currentIndex);
}
function selectBatchItem(index) {
  const item = state.batchResult?.items?.[index];
  if (!item) return;
  state.selectedBatchTestId = String(item.testId || `index-${index}`);
  renderBatchItems(state.batchResult.items || []);
  showBatchItemOverview(item, index);
  void loadBatchItemBottleneck(item, index);
}
function showCurrentBatchOverview() {
  if (!state.batchResult) return;
  state.selectedBatchTestId = "";
  renderBatchItems(state.batchResult.items || []);
  showBatchOverviewMetrics(state.batchResult);
}
function groupAnalysisComparisonKey(testCase) {
  return JSON.stringify({ rounds: testCase?.rounds || [] });
}
function showAnalysisWizardStep(step) {
  analysisWizardStep = Math.max(1, Math.min(3, Number(step) || 1));
  document.querySelectorAll("[data-analysis-page]").forEach((page) => {
    const active = Number(page.dataset.analysisPage) === analysisWizardStep;
    page.hidden = !active;
    page.classList.toggle("active", active);
  });
  document.querySelectorAll("[data-analysis-flow-step]").forEach((item) => {
    const itemStep = Number(item.dataset.analysisFlowStep);
    item.classList.toggle("active", itemStep === analysisWizardStep);
    item.classList.toggle("complete", itemStep < analysisWizardStep);
  });
  const descriptions = {
    1: "\u9010\u9879\u9009\u62E9\u672C\u6B21\u9700\u8981\u5B9E\u9645\u8BA1\u7B97\u7684\u6307\u6807\uFF0C\u9009\u62E9\u4F1A\u4FDD\u5B58\u4E3A\u4E2A\u4EBA\u8BBE\u7F6E\u3002",
    2: "\u9009\u62E9\u53C2\u4E0E\u5BF9\u6BD4\u7684\u6D4B\u8BD5\uFF0C\u5E76\u786E\u8BA4\u53C2\u8003\u6D4B\u8BD5\u3001\u7EDF\u8BA1\u7A97\u53E3\u548C\u65F6\u95F4\u9884\u7B97\u3002",
    3: "\u6B63\u5728\u6309\u6240\u9009\u6307\u6807\u8BA1\u7B97\uFF0C\u8FBE\u5230\u65F6\u95F4\u9884\u7B97\u65F6\u4F1A\u4FDD\u7559\u5DF2\u5B8C\u6210\u7ED3\u679C\u3002"
  };
  document.getElementById("analysisOptionsDescription").textContent = descriptions[analysisWizardStep];
  document.getElementById("analysisPreviousButton").hidden = analysisWizardStep !== 2;
  document.getElementById("analysisNextButton").hidden = analysisWizardStep !== 1;
  document.getElementById("startGroupAnalysisButton").hidden = analysisWizardStep !== 2;
  const cancelButton = document.getElementById("analysisOptionsCancel");
  cancelButton.textContent = analysisWizardStep === 3 ? "\u53D6\u6D88\u5206\u6790" : "\u53D6\u6D88";
}
function openGroupAnalysisOptions() {
  const result = state.batchResult;
  if (!result?.items?.length) return;
  const testsById = new Map((state.workspaceDevice?.tests || []).map((test) => [String(test.id), test]));
  const analyzable = result.items.filter((item) => hasBatchResultMetrics(item) && item.resultUrl);
  const options = document.getElementById("analysisTestOptions");
  options.innerHTML = analyzable.map((item, index) => `
    <label><input type="checkbox" checked value="${escapeHtml3(String(item.testId || `index-${index}`))}" data-analysis-test>
      <span><strong>${escapeHtml3(item.testName || `\u6D4B\u8BD5 ${index + 1}`)}</strong><small>${escapeHtml3(validationDisplay(item.validation))}</small></span>
    </label>`).join("");
  const reference = document.getElementById("analysisReferenceTest");
  reference.innerHTML = analyzable.map((item, index) => `
    <option value="${escapeHtml3(String(item.testId || `index-${index}`))}">${escapeHtml3(item.testName || `\u6D4B\u8BD5 ${index + 1}`)}</option>`).join("");
  reference.dataset.testsById = String(testsById.size);
  document.getElementById("analysisToggleAllTests").textContent = "\u53D6\u6D88\u5168\u9009";
  document.getElementById("analysisDialogProgress").innerHTML = "";
  document.getElementById("analysisOptionsCancel").disabled = false;
  document.getElementById("analysisOptionsClose").disabled = false;
  document.getElementById("startGroupAnalysisButton").disabled = false;
  showAnalysisWizardStep(1);
  document.getElementById("analysisOptionsDialog").showModal();
  window.setTimeout(() => document.querySelector("[data-analysis-metric]")?.focus(), 0);
}
function renderGroupAnalysisProgress(job) {
  const percent = Math.max(0, Math.min(100, Number(job.progress) || 0));
  const elapsed = Number(job.elapsedSeconds) || 0;
  document.getElementById("analysisDialogProgress").innerHTML = `
    <section class="group-analysis-progress" aria-live="polite">
      <header><div><small>\u6D4B\u8BD5\u7EC4\u7ED3\u679C\u5206\u6790</small><strong>${escapeHtml3(job.message || "\u6B63\u5728\u5206\u6790")}</strong></div><b>${percent}%</b></header>
      <div class="group-analysis-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><i style="width:${percent}%"></i></div>
      <p>${escapeHtml3(job.currentCaseName || "\u6B63\u5728\u51C6\u5907")} \xB7 \u5DF2\u5B8C\u6210 ${Number(job.completedCases) || 0}/${Number(job.totalCases) || 0} \u4E2A\u6D4B\u8BD5 \xB7 \u5DF2\u7528 ${elapsed.toFixed(1)} \u79D2 / ${Number(job.timeBudgetSeconds) || 0} \u79D2</p>
    </section>`;
  showAnalysisWizardStep(3);
}
async function showTestGroupAnalysis() {
  const result = state.batchResult;
  if (!result?.items?.length) return;
  const selectedIds = new Set(
    [...document.querySelectorAll("[data-analysis-test]:checked")].map((input) => String(input.value))
  );
  if (!selectedIds.size) throw new Error("\u8BF7\u81F3\u5C11\u9009\u62E9\u4E00\u4E2A\u6D4B\u8BD5");
  const metricIds = [...document.querySelectorAll("[data-analysis-metric]:checked")].map((input) => String(input.value));
  if (!metricIds.length) throw new Error("\u8BF7\u81F3\u5C11\u9009\u62E9\u4E00\u4E2A\u8BA1\u7B97\u6307\u6807");
  const testsById = new Map((state.workspaceDevice?.tests || []).map((test) => [String(test.id), test]));
  const cases = result.items.map((item, index) => ({ item, index })).filter(({ item, index }) => selectedIds.has(String(item.testId || `index-${index}`))).map(({ item, index }) => {
    const testId = String(item.testId || `index-${index}`);
    const testCase = testsById.get(testId);
    const resultId = String(item.resultUrl || "").startsWith("/api/results/") ? decodeURIComponent(String(item.resultUrl).slice("/api/results/".length)) : "";
    return {
      id: testId,
      name: item.testName || `t${index + 1}`,
      status: String(item.status || "unknown"),
      validation: String(item.validation || "unknown"),
      makespan: item.makespan,
      baselineMakespan: item.baseline?.status === "succeeded" ? item.baseline.makespan : null,
      cpuTimeMs: item.cpuTimeMs ?? item.totalElapsedMs,
      elapsedTimeMs: item.totalElapsedMs,
      error: item.error || item.baseline?.error || "",
      resultId,
      rounds: testCase?.rounds || [],
      comparisonKey: groupAnalysisComparisonKey(testCase)
    };
  });
  const referenceSelect = document.getElementById("analysisReferenceTest");
  const referenceCaseId = selectedIds.has(String(referenceSelect.value)) ? String(referenceSelect.value) : cases[0].id;
  await saveAnalysisSettingsPreferences();
  const job = await createTestGroupAnalysisJob({
    cases,
    device: state.device,
    routes: state.workspaceDevice?.routes || state.routes,
    metricIds,
    referenceCaseId,
    windowMode: document.getElementById("analysisWindowMode").value,
    timeBudgetSeconds: Number(document.getElementById("analysisTimeBudget").value)
  });
  activeGroupAnalysisJobId = String(job.id || "");
  let snapshot = job;
  renderGroupAnalysisProgress(snapshot);
  while (["queued", "running"].includes(String(snapshot.status))) {
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    snapshot = await readTestGroupAnalysisJob(activeGroupAnalysisJobId);
    renderGroupAnalysisProgress(snapshot);
  }
  activeGroupAnalysisJobId = "";
  if (!snapshot.result) throw new Error(snapshot.message || "\u7ED3\u679C\u5206\u6790\u5931\u8D25");
  const summary = snapshot.result;
  const panelMarkup = renderTestGroupAnalysis(
    summary,
    result.group || state.activeTestGroup || "\u5F53\u524D\u6D4B\u8BD5\u7EC4"
  );
  visualizationWorkspace.showGroupAnalysis(panelMarkup);
  document.getElementById("analysisOptionsCancel").disabled = false;
  document.getElementById("analysisOptionsClose").disabled = false;
  document.getElementById("analysisOptionsDialog").close();
  switchTab("workspace");
  const panel = document.getElementById("testGroupAnalysisPanel");
  bindTestGroupExport(panel, summary, result.group || state.activeTestGroup || "\u5F53\u524D\u6D4B\u8BD5\u7EC4");
  panel.querySelector("[data-reconfigure-analysis]")?.addEventListener("click", openGroupAnalysisOptions);
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}
function bindTestGroupExport(panel, summary, groupName) {
  const button = panel?.querySelector("[data-group-export-csv]");
  if (!button) return;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = String(groupName || "\u6D4B\u8BD5\u7EC4").replace(/[\\/:*?"<>|]/g, "_");
    const blob = new Blob([`\uFEFF${testGroupSummaryCsv(summary)}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `\u6D4B\u8BD5\u7EC4\u6307\u6807-${safeName}-${stamp}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });
}
function batchItemsRenderSignature(items) {
  return JSON.stringify(items.map((item) => [
    item.status,
    item.resultUrl,
    item.logUrl,
    item.error,
    item.validation,
    item.makespan,
    item.cpuTimeMs,
    item.baseline?.status
  ]));
}
function orderedBatchItems(items) {
  return [...items].sort((left, right) => Number(left.index ?? 0) - Number(right.index ?? 0));
}
function showBatchProgress(result) {
  result.items = orderedBatchItems(result.items || []);
  const completed = Number(result.completed || 0), total = Number(result.testCount || result.items?.length || 0);
  const percent = total ? Math.round(completed / total * 100) : 0;
  const progress = document.getElementById("batchProgress");
  document.getElementById("testGroupAnalysisButton").hidden = !["completed", "cancelled"].includes(result.status);
  progress.classList.add("visible");
  progress.setAttribute("aria-valuenow", String(percent));
  document.getElementById("batchProgressCount").textContent = `${percent}%`;
  document.getElementById("batchProgressBar").style.width = `${percent}%`;
  state.batchResult = result;
  updateBatchLogDownload(result);
  if (!state.selectedBatchTestId) showBatchOverviewMetrics(result);
  const items = result.items || [];
  const renderSignature = batchItemsRenderSignature(items);
  if (renderSignature !== lastBatchItemsRenderSignature) {
    renderBatchItems(items);
    lastBatchItemsRenderSignature = renderSignature;
  }
  const selectedIndex = (result.items || []).findIndex((item, index) => String(item.testId || `index-${index}`) === state.selectedBatchTestId);
  if (selectedIndex >= 0) {
    showBatchItemOverview(result.items[selectedIndex], selectedIndex);
    void loadBatchItemBottleneck(result.items[selectedIndex], selectedIndex);
  }
  if (["completed", "cancelled"].includes(String(result.status))) {
    void hydrateBatchCardAnalyses(items);
  }
  writeTerminal([
    "$ \u6279\u91CF\u8FD0\u884C\u5F53\u524D\u6D4B\u8BD5\u7EC4",
    `  \u7EC4\u522B: ${result.group || "\u672A\u5206\u7EC4"} \xB7 \u7B56\u7565: ${displayStrategyName(result.strategy)}`,
    `  \u8FDB\u5EA6: ${completed}/${total} (${percent}%) \xB7 \u7B97\u6CD5\u5E76\u884C: ${result.workerCount}${result.validationWorkers > 0 ? ` \xB7 HongYe \u6821\u9A8C\u5E76\u884C: ${result.validationWorkers}` : ""}`,
    `  \u7B49\u5F85: ${(result.items || []).filter((item) => item.status === "queued").length} \xB7 \u8FD0\u884C\u4E2D: ${(result.items || []).filter((item) => item.status === "running").length} \xB7 \u6210\u529F: ${result.succeeded || 0} \xB7 \u5931\u8D25: ${result.failed || 0} \xB7 \u7EC8\u6B62: ${result.cancelled || 0}`
  ].join("\n"));
}
function batchItemErrorText(item) {
  const baseline = item.baseline || {};
  if (baseline.status === "failed") return `Baseline \u5931\u8D25\uFF1A${baseline.error || "\u7B49\u5F85\u91CD\u65B0\u8BA1\u7B97"}`;
  if (item.status === "failed") {
    const deadlock = deadlockDisplay(item.deadlock);
    if (deadlock) return `[${deadlock.deadlockCode}] ${deadlock.title}\uFF1A${deadlock.message || item.error || "\u7B97\u6CD5\u89C4\u5212\u8FDB\u5165\u6B7B\u9501"}`;
    return `${hasBatchResultMetrics(item) ? "\u6821\u9A8C\u5931\u8D25" : "\u8FD0\u884C\u5931\u8D25"}\uFF1A${item.error || "\u672A\u77E5\u9519\u8BEF"}`;
  }
  if (baseline.status && baseline.status !== "succeeded" && baseline.status !== "skipped") return `Baseline \u5931\u6548\uFF1A${baseline.error || "\u7B49\u5F85\u91CD\u65B0\u8BA1\u7B97"}`;
  return "";
}
async function loadBatchCardAnalysis(item) {
  const resultUrl = String(item?.resultUrl || "");
  if (!resultUrl || !hasBatchResultMetrics(item)) return null;
  if (batchCardAnalyses.has(resultUrl)) return batchCardAnalyses.get(resultUrl);
  if (batchCardAnalysisRequests.has(resultUrl)) return batchCardAnalysisRequests.get(resultUrl);
  const request = (async () => {
    const testCase = (state.workspaceDevice?.tests || []).find(
      (test) => String(test.id) === String(item.testId)
    );
    const resultId = resultUrl.startsWith("/api/results/") ? decodeURIComponent(resultUrl.slice("/api/results/".length)) : "";
    if (!resultId) return null;
    try {
      const response = await requestScheduleAnalysis({
        resultId,
        device: state.device,
        windowMode: "steady",
        routes: state.workspaceDevice?.routes || state.routes,
        rounds: testCase?.rounds || [],
        metricGroups: ["basic", "throughput"]
      });
      batchCardAnalyses.set(resultUrl, response.analysis);
      return response.analysis;
    } catch {
      batchCardAnalyses.set(resultUrl, null);
      return null;
    } finally {
      batchCardAnalysisRequests.delete(resultUrl);
    }
  })();
  batchCardAnalysisRequests.set(resultUrl, request);
  return request;
}
async function hydrateBatchCardAnalyses(items) {
  const pending = orderedBatchItems(items).filter((item) => {
    const resultUrl = String(item?.resultUrl || "");
    return resultUrl && !batchCardAnalyses.has(resultUrl) && !batchCardAnalysisRequests.has(resultUrl);
  });
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < pending.length) {
      const item = pending[nextIndex++];
      await loadBatchCardAnalysis(item);
      if (state.batchResult) renderBatchItems(state.batchResult.items || []);
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, pending.length) }, worker));
}
function renderBatchItems(items) {
  items = orderedBatchItems(items);
  const statusLabels = { queued: "\u7B49\u5F85\u4E2D", running: "\u8FD0\u884C\u4E2D", succeeded: "\u6210\u529F", failed: "\u5931\u8D25", cancelled: "\u5DF2\u7EC8\u6B62" };
  document.getElementById("batchResults").innerHTML = items.map((item, index) => {
    const hasMetrics = hasBatchResultMetrics(item);
    const resultUrl = String(item.resultUrl || "");
    const cardAnalysis = batchCardAnalyses.get(resultUrl);
    const throughput = Number(cardAnalysis?.throughputPerHour);
    const rawAverageRecomputeTime = cardAnalysis?.averageRecomputeTimeMs ?? item.averageRecomputeTimeMs;
    const averageRecomputeTime = Number(rawAverageRecomputeTime);
    const hasThroughput = Number.isFinite(throughput) && throughput > 0;
    const hasAverageRecomputeTime = rawAverageRecomputeTime !== null && rawAverageRecomputeTime !== void 0 && Number.isFinite(averageRecomputeTime);
    const summaryError = batchItemErrorText(item);
    const failed = Boolean(summaryError);
    const summaryNote = item.status === "cancelled" ? "\u8C03\u5EA6\u5DF2\u7EC8\u6B62" : failed ? "" : summaryError;
    const displayId = `t${index + 1}`;
    const itemSelectionId = String(item.testId || `index-${index}`);
    const selected = itemSelectionId === state.selectedBatchTestId;
    return `
      <div class="batch-result ${escapeHtml3(item.status || "queued")}${selected ? " selected" : ""}" data-batch-item-index="${index}">
        <div class="batch-result-head">
          <button class="batch-result-title" type="button" aria-pressed="${selected}" aria-label="\u67E5\u770B ${escapeHtml3(item.testName || `\u6D4B\u8BD5 ${index + 1}`)} \u7684\u8BE6\u7EC6\u6307\u6807"><strong title="${escapeHtml3(item.testName || `\u6D4B\u8BD5 ${index + 1}`)}">${escapeHtml3(item.testName || `\u6D4B\u8BD5 ${index + 1}`)}</strong></button>
          <div class="batch-result-meta">
            <span class="batch-status">${statusLabels[item.status] || "\u7B49\u5F85\u4E2D"}</span>
            ${item.logUrl ? `<a class="btn" href="${escapeHtml3(item.logUrl)}" download="${escapeHtml3(readableLogFileName(item.testName || `\u6D4B\u8BD5-${index + 1}`))}">\u65E5\u5FD7</a>` : `<span class="btn" aria-disabled="true">\u65E5\u5FD7</span>`}
            ${item.resultUrl ? `<button class="btn primary" type="button" data-playback-result="${escapeHtml3(item.resultUrl)}" data-playback-name="${escapeHtml3(item.testName || `\u6D4B\u8BD5 ${index + 1}`)}">\u56DE\u653E</button>` : `<span class="btn" aria-disabled="true">\u56DE\u653E</span>`}
            ${item.ganttUrl ? `<a class="btn" href="${escapeHtml3(item.ganttUrl)}" target="_blank">\u7518\u7279\u56FE</a>` : `<span class="btn" aria-disabled="true">\u7518\u7279\u56FE</span>`}
            ${failed ? `<button class="btn danger" type="button" data-batch-error="${index}" aria-label="\u67E5\u770B ${escapeHtml3(displayId)} \u7684\u62A5\u9519\u4FE1\u606F">\u62A5\u9519</button>` : ""}
          </div>
        </div>
        <div class="batch-result-summary">
          <div class="batch-metric-tags" aria-label="\u4E3B\u8981\u6307\u6807">
            <span class="batch-metric-tag production">${hasThroughput ? `\u4EA7\u80FD ${throughput.toFixed(1)} \u7247/h` : `Makespan ${hasMetrics && Number.isFinite(Number(item.makespan)) ? `${Number(item.makespan).toFixed(2)} s` : "\u2014"}`}</span>
            <span class="batch-metric-tag recompute">\u5E73\u5747\u91CD\u7B97 ${hasMetrics && hasAverageRecomputeTime ? `${averageRecomputeTime.toFixed(1)} ms` : "\u2014"}</span>
          </div>
          ${summaryNote ? `<span class="summary-error" title="${escapeHtml3(summaryNote)}">${escapeHtml3(summaryNote)}</span>` : ""}
        </div>
      </div>`;
  }).join("");
}
function openBatchErrorDialog(index) {
  const item = state.batchResult?.items?.[index];
  if (!item) return;
  const errorText = batchItemErrorText(item) || "\u672A\u77E5\u9519\u8BEF";
  document.getElementById("batchErrorDialogContext").textContent = `${item.testName || `\u6D4B\u8BD5 ${index + 1}`} \xB7 ${item.status === "failed" ? "\u8FD0\u884C\u5931\u8D25" : "\u57FA\u7EBF\u5F02\u5E38"}`;
  document.getElementById("batchErrorDialogContent").textContent = errorText;
  document.getElementById("batchErrorDialog").showModal();
}
function batchGanttUrl(items) {
  const params = new URLSearchParams();
  items.filter((item) => item.resultUrl).forEach((item) => {
    params.append("src", item.resultUrl);
    params.append("name", item.testName);
  });
  return params.size ? `/movelist_gantt_viewer.html?${params.toString()}` : "";
}
function updateBatchLogDownload(result) {
  const button = document.getElementById("batchLogButton");
  const hasLogs = (result.items || []).some((item) => item.logUrl);
  if (!result.batchId || !hasLogs) {
    button.href = "#";
    button.setAttribute("aria-disabled", "true");
    return;
  }
  button.href = `/api/run-batches/${encodeURIComponent(result.batchId)}/logs`;
  const deviceName = String(result.deviceName || "\u5F53\u524D\u8BBE\u5907").replace(/\.json$/i, "");
  const readableDeviceName = deviceName.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_") || "\u5F53\u524D\u8BBE\u5907";
  const readableGroupName = String(result.group || "\u5F53\u524D\u6D4B\u8BD5\u7EC4").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_") || "\u5F53\u524D\u6D4B\u8BD5\u7EC4";
  button.download = `\u6279\u91CF\u590D\u73B0\u65E5\u5FD7-${readableDeviceName}-${readableGroupName}.zip`;
  button.removeAttribute("aria-disabled");
}
function showBatchResult(result) {
  state.batchResult = result;
  updateBatchLogDownload(result);
  document.getElementById("testGroupAnalysisButton").hidden = false;
  if (!state.selectedBatchTestId) showBatchOverviewMetrics(result);
  const resultErrors = result.items.flatMap((item, index) => {
    if (item.status === "failed") {
      return [`t${index + 1} ${item.testName || ""}\uFF1A${item.error || "\u8FD0\u884C\u5931\u8D25"}`];
    }
    if (item.status === "succeeded" && item.validation && item.validation !== "passed" && item.validation !== "skipped") {
      return [`t${index + 1} ${item.testName || ""}\uFF1AMoveList \u6821\u9A8C ${validationDisplay(item.validation)}${item.error ? `\uFF1B${item.error}` : ""}`];
    }
    return [];
  });
  writeTerminal(resultErrors.join("\n"), resultErrors.length > 0);
  renderBatchItems(result.items);
  const selectedIndex = result.items.findIndex((item, index) => String(item.testId || `index-${index}`) === state.selectedBatchTestId);
  if (selectedIndex >= 0) {
    showBatchItemOverview(result.items[selectedIndex], selectedIndex);
    void loadBatchItemBottleneck(result.items[selectedIndex], selectedIndex);
  }
  const first = result.items.find((item) => item.ganttUrl || item.logUrl);
  if (first) {
    if (first.ganttUrl) {
      const gantt = document.getElementById("ganttButton");
      gantt.href = first.ganttUrl;
      gantt.removeAttribute("aria-disabled");
    }
    if (first.logUrl) {
      const log = document.getElementById("logButton");
      log.href = first.logUrl;
      log.download = readableLogFileName(first.testName);
      log.removeAttribute("aria-disabled");
    }
  }
  const allGanttUrl = batchGanttUrl(result.items);
  const allGantt = document.getElementById("batchGanttButton");
  if (allGanttUrl) {
    allGantt.href = allGanttUrl;
    allGantt.removeAttribute("aria-disabled");
  }
}
function showResult(result) {
  state.batchResult = null;
  state.selectedBatchTestId = "";
  document.getElementById("testGroupAnalysisButton").hidden = true;
  document.getElementById("testGroupAnalysisPanel").hidden = true;
  document.getElementById("batchProgress").classList.remove("visible");
  document.getElementById("batchResults").innerHTML = "";
  const allGantt = document.getElementById("batchGanttButton");
  allGantt.href = "#";
  allGantt.setAttribute("aria-disabled", "true");
  updateBatchLogDownload({});
  const baseline = result.baseline || {}, baselineReady = baseline.status === "succeeded";
  const cpuTime = Number(result.cpuTimeMs ?? result.totalElapsedMs);
  document.getElementById("metricContext").textContent = "\u5F53\u524D\u6D4B\u8BD5";
  document.getElementById("batchOverviewButton").hidden = true;
  ["metricTimeDetail", "metricMakespanDetail", "metricMovesDetail", "metricValidationDetail"].forEach((id) => {
    document.getElementById(id).textContent = "";
  });
  document.getElementById("metricTimeLabel").textContent = "CPU Time";
  document.getElementById("metricMakespanLabel").textContent = "Makespan / Baseline";
  setBottleneckMetric(result.bottleneckUtilization, "\u6CA1\u6709\u8DB3\u591F\u7684\u8D44\u6E90\u6D3B\u52A8");
  document.getElementById("metricValidationLabel").textContent = "Validation";
  document.getElementById("metricTime").textContent = `${cpuTime.toFixed(1)} ms`;
  document.getElementById("metricMakespan").textContent = `${result.makespan.toFixed(2)} / ${baselineReady ? Number(baseline.makespan).toFixed(2) : "\u2014"} s`;
  const validationValue = validationDisplay(result.validation);
  document.getElementById("metricValidation").textContent = validationValue;
  document.getElementById("metricValidation").closest(".metric").classList.toggle("is-success", result.validation === "passed");
  document.getElementById("metricValidation").closest(".metric").classList.toggle("is-error", result.validation !== "passed" && result.validation !== "skipped");
  const objectiveDiagnostics = [...result.rounds || []].reverse().map((round) => round.strategyDiagnostics).find((diagnostics) => diagnostics?.metrics);
  if (objectiveDiagnostics) {
    const metrics = objectiveDiagnostics.metrics;
    document.getElementById("metricValidationLabel").textContent = "Validation / Multi-metric";
    document.getElementById("metricValidationDetail").textContent = `\u9A7B\u7559\u8D85\u9650 ${Number(metrics.residencyViolationCount) || 0} \u6B21 \xB7 \u6700\u5927\u6301\u7247 ${Number(metrics.maximumRobotHoldingSeconds || 0).toFixed(2)} s \xB7 \u7CFB\u7EDF\u505C\u7559 CV ${Number(metrics.systemResidenceCv || 0).toFixed(3)}`;
  }
  const dualActorDiagnostics = (result.rounds || []).map((round) => round.strategyDiagnostics).filter((diagnostics) => diagnostics?.selectedSource === "dual-actor-e2e");
  if (dualActorDiagnostics.length) {
    const totals = dualActorDiagnostics.reduce((summary, diagnostics) => ({
      atmosphere: summary.atmosphere + (Number(diagnostics.actorDecisionCounts?.atmosphere) || 0),
      vacuum: summary.vacuum + (Number(diagnostics.actorDecisionCounts?.vacuum) || 0),
      pick: summary.pick + (Number(diagnostics.primitiveActionCounts?.pick) || 0),
      place: summary.place + (Number(diagnostics.primitiveActionCounts?.place) || 0),
      swap: summary.swap + (Number(diagnostics.primitiveActionCounts?.swap) || 0)
    }), { atmosphere: 0, vacuum: 0, pick: 0, place: 0, swap: 0 });
    document.getElementById("metricValidationLabel").textContent = "Validation / Dual Actor";
    document.getElementById("metricValidationDetail").textContent = `\u51B3\u7B56\uFF1A\u5927\u6C14 ${totals.atmosphere} \xB7 \u771F\u7A7A ${totals.vacuum}\uFF1B\u539F\u5B50\u52A8\u4F5C\uFF1APick ${totals.pick} \xB7 Place ${totals.place} \xB7 Swap ${totals.swap}`;
  }
  writeTerminal(["$ \u8C03\u5EA6\u5B8C\u6210", ...(result.rounds || []).map((round) => {
    if (round.kind === "initial") return `  #${round.index} \u9996\u6B21 | ${round.elapsedMs.toFixed(1)} ms`;
    const request = Number(round.requestedTime);
    const recoveryEnd = Number(round.recoveryEndTime ?? round.effectiveTime);
    const triggerLabel = round.trigger === "cjob-cycle" ? "CJobCycle \u8865\u7247\u91CD\u7B97" : "\u5B9A\u65F6\u91CD\u7B97";
    const timing = Math.abs(recoveryEnd - request) > 1e-6 ? `@${request}s ${triggerLabel} \xB7 \u56FA\u5B9A\u65E7\u52A8\u4F5C\u6536\u5C3E\u81F3 @${recoveryEnd}s` : `@${request}s ${triggerLabel}`;
    return `  #${round.index} ${timing} | ${round.elapsedMs.toFixed(1)} ms`;
  }), "", ...result.logs || []].join("\n"));
  const gantt = document.getElementById("ganttButton");
  gantt.href = result.ganttUrl;
  gantt.removeAttribute("aria-disabled");
}
function showFailedResultMetrics(result) {
  state.batchResult = null;
  state.selectedBatchTestId = "";
  document.getElementById("testGroupAnalysisButton").hidden = true;
  document.getElementById("testGroupAnalysisPanel").hidden = true;
  document.getElementById("batchProgress").classList.remove("visible");
  document.getElementById("batchResults").innerHTML = "";
  const baseline = result?.baseline || {};
  const baselineMakespan = baseline.status === "succeeded" ? Number(baseline.makespan) : NaN;
  const makespan = Number(result?.makespan);
  const elapsedTime = Number(result?.totalElapsedMs ?? result?.cpuTimeMs);
  const improvement = Number(result?.improvementPercent);
  const makespanText = `${Number.isFinite(makespan) ? makespan.toFixed(2) : "\u2014"} / ${Number.isFinite(baselineMakespan) ? baselineMakespan.toFixed(2) : "\u2014"} s`;
  const comparisonDetail = Number.isFinite(improvement) ? `${improvement >= 0 ? "\u63D0\u5347" : "\u9000\u5316"} ${Math.abs(improvement).toFixed(2)}% \xB7 \u7ED3\u679C\u6821\u9A8C\u672A\u901A\u8FC7` : baseline.status === "skipped" ? "" : baseline.status && baseline.status !== "succeeded" ? `Baseline ${baseline.status === "failed" ? "\u5931\u8D25" : "\u5931\u6548"}` : "\u5916\u90E8\u7B97\u6CD5\u672A\u8FD4\u56DE\u53EF\u6BD4\u8F83\u7684\u5B8C\u6574 Makespan";
  document.getElementById("metricContext").textContent = "\u5F53\u524D\u6D4B\u8BD5 \xB7 \u5916\u90E8\u7B97\u6CD5\u5931\u8D25\u7ED3\u679C";
  document.getElementById("batchOverviewButton").hidden = true;
  setResultMetric("Time", "\u5931\u8D25\u524D\u8017\u65F6", Number.isFinite(elapsedTime) ? `${elapsedTime.toFixed(1)} ms` : "\u2014", "\u4ECE\u63D0\u4EA4\u5230\u8FD4\u56DE\u5931\u8D25\u7ED3\u679C");
  setResultMetric("Makespan", "Makespan / Baseline", makespanText, comparisonDetail);
  setBottleneckMetric(result?.bottleneckUtilization, result?.resultId ? "\u5931\u8D25\u7ED3\u679C\u6CA1\u6709\u8DB3\u591F\u7684\u8D44\u6E90\u6D3B\u52A8" : "\u672A\u751F\u6210\u53EF\u5206\u6790\u7684 MoveList");
  setResultMetric("Validation", "Validation", result?.validation === "failed" ? "\u672A\u901A\u8FC7" : String(result?.validation || "\u5931\u8D25"), result?.error || "");
  document.getElementById("metricValidation").closest(".metric").classList.remove("is-success");
  document.getElementById("metricValidation").closest(".metric").classList.add("is-error");
}
function writeTerminal(message, error = false) {
  const panel = document.getElementById("resultErrorPanel");
  const details = document.getElementById("resultErrorDetails");
  const terminal = document.getElementById("terminal");
  if (!error) {
    details.innerHTML = "";
    details.hidden = true;
    terminal.textContent = "";
    terminal.hidden = false;
    panel.hidden = true;
    return;
  }
  details.innerHTML = "";
  details.hidden = true;
  terminal.hidden = false;
  terminal.textContent = String(message || "\u672A\u77E5\u9519\u8BEF").replace(/^\$\s*/, "");
  panel.hidden = false;
}
function renderRunFailureCard({
  cancelled,
  errorMessage,
  deadlock,
  validationIssues,
  baselineError
}) {
  const panel = document.getElementById("resultErrorPanel");
  const details = document.getElementById("resultErrorDetails");
  const terminal = document.getElementById("terminal");
  const issueRows = validationIssues.map((rawIssue) => {
    const issue = String(rawIssue || "").trim();
    const matched = issue.match(/^\[([A-Z0-9-]+)\]\s*/);
    const code = matched?.[1] || "MVL-UNKNOWN";
    const message = matched ? issue.slice(matched[0].length) : issue;
    return `<li><code>${escapeHtml3(code)}</code><span>${escapeHtml3(message || issue)}</span></li>`;
  }).join("");
  const validationFailure = validationIssues.length > 0;
  const informationType = cancelled ? "\u8FD0\u884C\u5DF2\u7EC8\u6B62" : deadlock ? "\u7B97\u6CD5\u6B7B\u9501" : validationFailure ? "MoveList \u6821\u9A8C\u5931\u8D25" : baselineError ? "Baseline \u5931\u8D25" : "\u8FD0\u884C\u5F02\u5E38";
  const primaryCode = deadlock?.deadlockCode || (validationIssues[0]?.match(/^\s*\[([A-Z0-9-]+)\]/)?.[1] ?? "RUN-ERR-001");
  const summaryText = deadlock?.message || (cancelled ? "\u7528\u6237\u7EC8\u6B62\u4E86\u672C\u6B21\u8FD0\u884C" : errorMessage);
  const summaryMarkup = validationFailure ? `<strong>${escapeHtml3(summaryText || "\u672A\u63D0\u4F9B\u9519\u8BEF\u8BF4\u660E")}</strong>` : `<span class="error-summary-meta">[${escapeHtml3(informationType)} <i aria-hidden="true">|</i> <code>${escapeHtml3(primaryCode)}</code>]</span><strong>${escapeHtml3(summaryText || "\u672A\u63D0\u4F9B\u9519\u8BEF\u8BF4\u660E")}</strong>`;
  const validationSection = validationFailure ? "" : issueRows ? `
    <section class="error-detail-section" aria-labelledby="errorValidationTitle">
      <div class="error-detail-heading"><span id="errorValidationTitle">MoveList \u6821\u9A8C\u95EE\u9898</span><b>${validationIssues.length} \u9879</b></div>
      <ul class="error-issue-list">${issueRows}</ul>
    </section>` : "";
  const baselineSection = baselineError ? `
    <section class="error-detail-section">
      <div class="error-detail-heading"><span>Baseline</span><b>\u5931\u8D25</b></div>
      <p>${escapeHtml3(baselineError.replace(/^Baseline\s*失败：?\s*/, ""))}</p>
    </section>` : "";
  details.innerHTML = `
    <div class="error-summary-line">
      ${summaryMarkup}
    </div>
    ${validationSection}
    ${baselineSection}
  `;
  terminal.textContent = "";
  terminal.hidden = true;
  details.hidden = false;
  panel.hidden = false;
}
async function checkService() {
  const pill = document.getElementById("serviceState");
  const runButton = document.getElementById("runButton");
  const batchRunButton = document.getElementById("batchRunButton");
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) throw new Error();
    const status = await response.json(), compatible = status.schemaVersion === EXPECTED_API_SCHEMA;
    state.serviceCompatible = compatible;
    state.algorithmMetadata = status.algorithmMetadata || {};
    renderOtherAlgorithmOptions(status.algorithms || status.otherAlgorithms || []);
    runButton.disabled = !compatible || singleRunCancelling || state.batchRunning;
    batchRunButton.disabled = !compatible || singleRunActive || state.batchRunning && state.batchCancelRequested;
    renderWorkspaceControls();
    pill.textContent = compatible ? "\u672C\u5730\u670D\u52A1\u5DF2\u8FDE\u63A5" : "\u670D\u52A1\u7248\u672C\u8FC7\u65E7";
    if (!compatible) {
      pill.style.color = "var(--red)";
      pill.style.background = "var(--red-soft)";
      writeTerminal("$ \u672C\u5730\u670D\u52A1\u7248\u672C\u8FC7\u65E7\n  \u8BF7\u91CD\u542F: python -m realtime_scheduler.backend.main", true);
    }
  } catch {
    state.serviceCompatible = false;
    runButton.disabled = true;
    batchRunButton.disabled = true;
    renderWorkspaceControls();
    pill.textContent = "\u672C\u5730\u670D\u52A1\u672A\u8FDE\u63A5";
    pill.style.color = "var(--red)";
    pill.style.background = "var(--red-soft)";
    writeTerminal("$ \u65E0\u6CD5\u8FDE\u63A5\u672C\u5730\u670D\u52A1\n  \u8BF7\u8FD0\u884C: python -m realtime_scheduler.backend.main", true);
  }
}
document.getElementById("workspaceDialogCancel").addEventListener("click", () => document.getElementById("workspaceDialog").close("cancel"));
var batchErrorDialog = document.getElementById("batchErrorDialog");
document.getElementById("batchErrorDialogClose").addEventListener("click", () => batchErrorDialog.close());
document.getElementById("batchErrorDialogConfirm").addEventListener("click", () => batchErrorDialog.close());
document.getElementById("batchErrorDialogCopy").addEventListener("click", async () => {
  const content = document.getElementById("batchErrorDialogContent")?.textContent || "";
  try {
    await navigator.clipboard.writeText(content);
  } catch {
  }
});
batchErrorDialog.addEventListener("click", (event) => {
  if (event.target === batchErrorDialog) batchErrorDialog.close();
});
document.getElementById("cleanDialogCancel").addEventListener("click", () => {
  document.getElementById("cleanDialog").close();
  state.cleanDialogContext = null;
});
document.getElementById("cleanDialog").addEventListener("close", () => {
  state.cleanDialogContext = null;
});
document.getElementById("pjobRouteDialogClose").addEventListener("click", () => closePJobRoutePicker());
document.getElementById("pjobRouteDialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  closePJobRoutePicker();
});
document.getElementById("pjobRouteDialog").addEventListener("click", (event) => {
  if (event.target.id === "pjobRouteDialog") closePJobRoutePicker();
});
var bottleneckAnalysisHelpDialog = document.getElementById("bottleneckAnalysisHelpDialog");
document.getElementById("bottleneckAnalysisHelpDialogClose").addEventListener("click", () => bottleneckAnalysisHelpDialog.close());
var residenceAnalysisHelpDialog = document.getElementById("residenceAnalysisHelpDialog");
document.getElementById("residenceAnalysisHelpDialogClose").addEventListener("click", () => residenceAnalysisHelpDialog.close());
var throughputAnalysisHelpDialog = document.getElementById("throughputAnalysisHelpDialog");
document.getElementById("throughputAnalysisHelpDialogClose").addEventListener("click", () => throughputAnalysisHelpDialog.close());
document.getElementById("visualPerformance").addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  if (event.target.closest("#bottleneckAnalysisHelpButton") && !bottleneckAnalysisHelpDialog.open) {
    bottleneckAnalysisHelpDialog.showModal();
  }
  if (event.target.closest("#residenceAnalysisHelpButton") && !residenceAnalysisHelpDialog.open) {
    residenceAnalysisHelpDialog.showModal();
  }
  if (event.target.closest("#throughputAnalysisHelpButton") && !throughputAnalysisHelpDialog.open) {
    throughputAnalysisHelpDialog.showModal();
  }
});
document.getElementById("visualPerformance").addEventListener("change", (event) => {
  const select = event.target instanceof HTMLSelectElement && (event.target.id === "residenceMetricSelect" || event.target.id === "throughputMetricSelect" || event.target.id === "throughputWindowSize" || event.target.id === "throughputRangeSelect") ? event.target : null;
  if (!select) return;
  const performancePanel = event.currentTarget;
  if (!(performancePanel instanceof HTMLElement)) return;
  const selectedMetric = select.value;
  if (select.id === "residenceMetricSelect") {
    performancePanel.querySelectorAll("[data-residence-metric-chart]").forEach((chart) => {
      chart.hidden = chart.dataset.residenceMetricChart !== selectedMetric;
    });
    performancePanel.querySelectorAll("[data-residence-summary]").forEach((summary) => {
      summary.hidden = summary.dataset.residenceSummary !== selectedMetric;
    });
    return;
  }
  const throughputMode = performancePanel.querySelector("#throughputMetricSelect")?.value ?? "cumulative";
  const throughputWindow = performancePanel.querySelector("#throughputWindowSize")?.value ?? "5";
  const activeThroughputChart = throughputMode === "rolling" ? `rolling-${throughputWindow}` : "cumulative";
  performancePanel.querySelectorAll("[data-throughput-window-control]").forEach((control) => {
    control.hidden = throughputMode !== "rolling";
  });
  performancePanel.querySelectorAll("[data-throughput-chart]").forEach((chart) => {
    chart.hidden = chart.dataset.throughputChart !== activeThroughputChart;
  });
  performancePanel.querySelectorAll("[data-throughput-summary]").forEach((summary) => {
    summary.hidden = summary.dataset.throughputSummary !== activeThroughputChart;
  });
  const range = performancePanel.querySelector("#throughputRangeSelect")?.value ?? "wafer:30";
  const activeChart = performancePanel.querySelector(`[data-throughput-chart="${activeThroughputChart}"]`);
  if (activeChart?.dataset.throughputPoints) updateThroughputChartRange(activeChart, range);
});
document.getElementById("bottleneckAnalysisHelpDialog").addEventListener("click", (event) => {
  if (event.target === bottleneckAnalysisHelpDialog) bottleneckAnalysisHelpDialog.close();
});
document.getElementById("residenceAnalysisHelpDialog").addEventListener("click", (event) => {
  if (event.target === residenceAnalysisHelpDialog) residenceAnalysisHelpDialog.close();
});
document.getElementById("throughputAnalysisHelpDialog").addEventListener("click", (event) => {
  if (event.target === throughputAnalysisHelpDialog) throughputAnalysisHelpDialog.close();
});
document.getElementById("pjobRouteProcess").addEventListener("change", (event) => renderPJobRouteDialogGroup(event.target.value));
document.getElementById("pjobRouteParallel").addEventListener("change", (event) => renderPJobRouteDialogGroup(pjobRoutePickerContext?.processKey, event.target.value));
document.getElementById("routeProcessFilter").addEventListener("change", (event) => {
  state.routeProcessFilter = event.target.value;
  state.routeParallelFilter = "";
  renderRoutes();
});
document.getElementById("routeParallelFilter").addEventListener("change", (event) => {
  state.routeParallelFilter = event.target.value;
  renderRoutes();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.getElementById("pjobRouteDialog").open && !document.getElementById("drawerLayer").open) {
    event.preventDefault();
    closePJobRoutePicker();
  }
});
document.getElementById("cleanPlacement").addEventListener("change", updateCleanDialogFields);
document.getElementById("cleanType").addEventListener("change", (event) => {
  const previousType = state.cleanDialogContext?.draft?.cleanType;
  const nextType = event.target.value;
  if (!["dummy", "dummywac"].includes(previousType) && ["dummy", "dummywac"].includes(nextType)) {
    document.getElementById("cleanDummyWaferCount").value = String(DEFAULT_DUMMY_WAFER_COUNT);
  }
  if (state.cleanDialogContext) state.cleanDialogContext.draft.cleanType = nextType;
  updateCleanDialogFields();
});
document.getElementById("cleanDialogForm").addEventListener("submit", (event) => {
  event.preventDefault();
  saveCleanDialog();
});
document.getElementById("workspaceImportButton").addEventListener("click", () => openDataTransferDialog("import"));
document.getElementById("workspaceExportButton").addEventListener("click", () => openDataTransferDialog("export"));
document.getElementById("dataTransferDialogClose").addEventListener("click", () => document.getElementById("dataTransferDialog").close());
document.getElementById("dataTransferDialog").addEventListener("cancel", (event) => {
  if (document.getElementById("dataTransferDialog").classList.contains("is-busy")) event.preventDefault();
});
document.getElementById("deviceTransferOption").addEventListener("click", () => chooseDataTransfer("device"));
document.getElementById("testTransferOption").addEventListener("click", () => chooseDataTransfer("test"));
document.getElementById("dataTransferDialog").addEventListener("click", (event) => {
  if (event.target === document.getElementById("dataTransferDialog") && !document.getElementById("dataTransferDialog").classList.contains("is-busy")) event.target.close();
});
document.getElementById("deviceFile").addEventListener("change", (event) => {
  const input = event.currentTarget;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  setDataTransferBusy(true);
  const operation = file.name.toLowerCase().endsWith(".json") ? loadDevice(file) : runWorkspaceTransfer("device", file);
  operation.catch((error) => {
    const status = document.getElementById("dataTransferStatus");
    status.textContent = error.message || "\u8BBE\u5907\u5BFC\u5165\u5931\u8D25";
    status.classList.add("error");
    setDataTransferBusy(false);
    writeTerminal(`$ \u8BBE\u5907\u8BFB\u53D6\u5931\u8D25
  ${error.message}`, true);
  });
});
document.getElementById("testExchangeFile").addEventListener("change", (event) => {
  const input = event.currentTarget;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  setDataTransferBusy(true);
  runWorkspaceTransfer("test", file).catch((error) => {
    const status = document.getElementById("dataTransferStatus");
    status.textContent = error.message || "\u6D4B\u8BD5\u96C6\u5BFC\u5165\u5931\u8D25";
    status.classList.add("error");
    setDataTransferBusy(false);
    writeTerminal(`$ \u6D4B\u8BD5\u96C6\u5BFC\u5165\u5931\u8D25
  ${error.message}`, true);
  });
});
document.getElementById("deviceSelect").addEventListener("change", (event) => (async () => {
  if (state.dirty) await saveCurrentTest(true);
  if (state.deviceTimingDirty) await saveDeviceTiming();
  await selectWorkspaceDevice(event.target.value);
})().catch((error) => writeTerminal(`$ \u8BBE\u5907\u5207\u6362\u5931\u8D25
  ${error.message}`, true)));
document.getElementById("deleteDeviceButton").addEventListener("click", () => deleteWorkspaceDevice().catch((error) => {
  setWorkspaceStatus(`\u5220\u9664\u8BBE\u5907\u5931\u8D25\uFF1A${error.message}`, "dirty");
  writeTerminal(`$ \u5220\u9664\u8BBE\u5907\u5931\u8D25
  ${error.message}`, true);
}));
document.getElementById("saveDeviceTimingButton").addEventListener("click", () => saveDeviceTiming().catch((error) => writeTerminal(`$ \u8BBE\u5907\u65F6\u95F4\u4FDD\u5B58\u5931\u8D25
  ${error.message}`, true)));
document.getElementById("resetDeviceTimingButton").addEventListener("click", () => resetDeviceTimingDraft("\u5DF2\u64A4\u9500\u5C1A\u672A\u4FDD\u5B58\u7684\u65F6\u95F4\u4FEE\u6539"));
document.getElementById("deviceStationSelect").addEventListener("change", (event) => {
  state.deviceStationName = event.target.value;
  renderDeviceTimingConfiguration();
});
document.getElementById("deviceRobotSelect").addEventListener("change", (event) => {
  state.deviceRobotName = event.target.value;
  renderDeviceTimingConfiguration();
});
document.getElementById("previousDeviceStationButton").addEventListener("click", () => stepDeviceTimingSelection("station", -1));
document.getElementById("nextDeviceStationButton").addEventListener("click", () => stepDeviceTimingSelection("station", 1));
document.getElementById("previousDeviceRobotButton").addEventListener("click", () => stepDeviceTimingSelection("robot", -1));
document.getElementById("nextDeviceRobotButton").addEventListener("click", () => stepDeviceTimingSelection("robot", 1));
document.getElementById("testGroupSelect").addEventListener("change", (event) => selectWorkspaceGroup(event.target.value).catch((error) => writeTerminal(`$ \u6D4B\u8BD5\u7EC4\u522B\u5207\u6362\u5931\u8D25
  ${error.message}`, true)));
document.getElementById("testCaseSelect").addEventListener("change", (event) => selectWorkspaceTest(event.target.value).catch((error) => writeTerminal(`$ \u6D4B\u8BD5\u96C6\u5207\u6362\u5931\u8D25
  ${error.message}`, true)));
document.getElementById("testCaseName").addEventListener("input", (event) => {
  state.testCaseName = event.target.value;
  markTestDirty();
});
document.getElementById("newGroupButton").addEventListener("click", () => createTestGroup().catch((error) => writeTerminal(`$ \u65B0\u5EFA\u6D4B\u8BD5\u7EC4\u522B\u5931\u8D25
  ${error.message}`, true)));
document.getElementById("renameGroupButton").addEventListener("click", () => renameCurrentTestGroup().catch((error) => {
  setWorkspaceStatus(`\u91CD\u547D\u540D\u6D4B\u8BD5\u7EC4\u522B\u5931\u8D25\uFF1A${error.message}`, "dirty");
  writeTerminal(`$ \u91CD\u547D\u540D\u6D4B\u8BD5\u7EC4\u522B\u5931\u8D25
  ${error.message}`, true);
}));
document.getElementById("deleteGroupButton").addEventListener("click", () => deleteCurrentTestGroup().catch((error) => {
  setWorkspaceStatus(`\u5220\u9664\u6D4B\u8BD5\u7EC4\u522B\u5931\u8D25\uFF1A${error.message}`, "dirty");
  writeTerminal(`$ \u5220\u9664\u6D4B\u8BD5\u7EC4\u522B\u5931\u8D25
  ${error.message}`, true);
}));
document.getElementById("newTestButton").addEventListener("click", () => createTestCase(false).catch((error) => writeTerminal(`$ \u65B0\u5EFA\u6D4B\u8BD5\u96C6\u5931\u8D25
  ${error.message}`, true)));
document.getElementById("emptyGroupNewTestButton").addEventListener("click", () => createTestCase(false).catch((error) => writeTerminal(`$ \u65B0\u5EFA\u6D4B\u8BD5\u96C6\u5931\u8D25
  ${error.message}`, true)));
document.getElementById("copyTestButton").addEventListener("click", () => createTestCase(true).catch((error) => writeTerminal(`$ \u590D\u5236\u6D4B\u8BD5\u96C6\u5931\u8D25
  ${error.message}`, true)));
document.getElementById("saveTestButton").addEventListener("click", () => saveCurrentTest(false).catch((error) => writeTerminal(`$ \u4FDD\u5B58\u6D4B\u8BD5\u96C6\u5931\u8D25
  ${error.message}`, true)));
document.getElementById("deleteTestButton").addEventListener("click", () => deleteCurrentTest().catch((error) => writeTerminal(`$ \u5220\u9664\u6D4B\u8BD5\u96C6\u5931\u8D25
  ${error.message}`, true)));
document.getElementById("roundCount").addEventListener("input", (event) => {
  resizeRounds(event.target.value);
  markTestDirty();
});
document.getElementById("runButton").addEventListener("click", runPlan);
document.getElementById("batchRunButton").addEventListener("click", runCurrentTestGroup);
document.getElementById("openRunSettingsButton").addEventListener("click", openRunSettingsDialog);
document.getElementById("runSettingsDialogClose").addEventListener("click", closeRunSettingsDialog);
document.getElementById("runSettingsDialog").addEventListener("close", finishRunSettingsDialog);
["hongYeCheckInput", "compatibilityModeInput", "executionTimingEnabledInput", "skipBaselineInput", "batchParallelismInput", "validationParallelismInput", ...CLEAN_VALIDATION_TYPES.map((type) => `cleanValidation${type[0].toUpperCase()}${type.slice(1)}Input`)].forEach((id) => {
  document.getElementById(id).addEventListener("change", () => {
    runSettingsPreferencesDirty = true;
    updateRunSettingsButtonLabel();
  });
});
updateRunSettingsButtonLabel();
document.getElementById("batchTestSelectionDialogClose").addEventListener("click", () => document.getElementById("batchTestSelectionDialog").close());
document.getElementById("batchTestSelectionDialogCancel").addEventListener("click", () => document.getElementById("batchTestSelectionDialog").close());
document.getElementById("batchSelectionSelectAll").addEventListener("click", () => setBatchTestSelection(() => true));
document.getElementById("batchSelectionClear").addEventListener("click", () => setBatchTestSelection(() => false));
document.getElementById("batchSelectionApplyRange").addEventListener("click", () => {
  const total = currentBatchGroupTests().length;
  const startInput = document.getElementById("batchSelectionRangeStart");
  const endInput = document.getElementById("batchSelectionRangeEnd");
  const rawStart = Math.min(total, Math.max(1, Number.parseInt(startInput.value, 10) || 1));
  const rawEnd = Math.min(total, Math.max(1, Number.parseInt(endInput.value, 10) || total));
  const start = Math.min(rawStart, rawEnd), end = Math.max(rawStart, rawEnd);
  startInput.value = String(start);
  endInput.value = String(end);
  setBatchTestSelection((index) => index + 1 >= start && index + 1 <= end);
});
document.getElementById("batchSelectionList").addEventListener("change", updateBatchSelectionCount);
document.getElementById("batchSelectionRunAll").addEventListener("click", () => runBatchSelection(true));
document.getElementById("batchTestSelectionForm").addEventListener("submit", (event) => {
  event.preventDefault();
  runBatchSelection(false);
});
document.getElementById("openSearchTreeOptionsDialogButton").addEventListener("click", openSearchTreeOptionsDialog);
document.getElementById("openHeuristicSettingsDialogButton").addEventListener("click", openHeuristicSettingsDialog);
document.getElementById("heuristicSettingsDialogCancel").addEventListener("click", () => document.getElementById("heuristicSettingsDialog").close());
document.getElementById("heuristicCustomWeightsEnabled").addEventListener("change", updateHeuristicWeightEditorState);
document.getElementById("heuristicSettingsForm").addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    saveHeuristicSettings();
  } catch (error) {
    document.getElementById("heuristicSettingsError").textContent = error.message;
  }
});
document.getElementById("searchTreeOptionsDialogCancel").addEventListener("click", () => document.getElementById("searchTreeOptionsDialog").close());
document.getElementById("searchTreeCheckpointFile").addEventListener("change", (event) => {
  pendingSearchTreeCheckpointFile = event.currentTarget.files?.[0] || null;
  if (!pendingSearchTreeCheckpointFile) return;
  document.getElementById("searchTreeCheckpointPath").value = pendingSearchTreeCheckpointFile.name;
  document.getElementById("searchTreeCheckpointHint").textContent = `\u5DF2\u9009\u62E9\u201C${pendingSearchTreeCheckpointFile.name}\u201D\uFF1B\u4FDD\u5B58\u53C2\u6570\u65F6\u4E0A\u4F20\u3002`;
});
document.getElementById("clearSearchTreeCheckpointButton").addEventListener("click", () => {
  pendingSearchTreeCheckpointFile = null;
  document.getElementById("searchTreeCheckpointFile").value = "";
  document.getElementById("searchTreeCheckpointPath").value = "";
  document.getElementById("searchTreeCheckpointHint").textContent = "\u4FDD\u5B58\u540E\u5C06\u4F7F\u7528\u9ED8\u8BA4\u6A21\u578B\u6216\u51B7\u542F\u52A8\u6A21\u578B\u3002";
});
document.getElementById("searchTreeOptionsForm").addEventListener("submit", (event) => {
  event.preventDefault();
  saveSearchTreeOptions().catch((error) => {
    document.getElementById("searchTreeCheckpointHint").textContent = error.message || "\u53C2\u6570\u4FDD\u5B58\u5931\u8D25";
  });
});
document.getElementById("batchOverviewButton").addEventListener("click", showCurrentBatchOverview);
document.getElementById("testGroupAnalysisButton").addEventListener("click", openGroupAnalysisOptions);
var cancelOrCloseAnalysisWizard = async () => {
  if (activeGroupAnalysisJobId) {
    document.getElementById("analysisOptionsCancel").disabled = true;
    document.getElementById("analysisOptionsClose").disabled = true;
    await cancelTestGroupAnalysisJob(activeGroupAnalysisJobId);
    return;
  }
  document.getElementById("analysisOptionsDialog").close();
};
document.getElementById("analysisOptionsClose").addEventListener("click", () => void cancelOrCloseAnalysisWizard());
document.getElementById("analysisOptionsCancel").addEventListener("click", () => void cancelOrCloseAnalysisWizard());
document.getElementById("analysisOptionsDialog").addEventListener("cancel", (event) => {
  if (!activeGroupAnalysisJobId) return;
  event.preventDefault();
  void cancelOrCloseAnalysisWizard();
});
document.getElementById("analysisOptionsDialog").addEventListener("close", () => {
  if (analysisSettingsPreferencesDirty) {
    saveAnalysisSettingsPreferences().catch((error) => writeTerminal(`$ \u5206\u6790\u8BBE\u7F6E\u4FDD\u5B58\u5931\u8D25
  ${error.message || "\u672A\u77E5\u9519\u8BEF"}`, true));
  }
});
document.getElementById("analysisNextButton").addEventListener("click", () => {
  if (!document.querySelector("[data-analysis-metric]:checked")) {
    writeTerminal("$ \u8BF7\u81F3\u5C11\u9009\u62E9\u4E00\u4E2A\u8BA1\u7B97\u6307\u6807", true);
    return;
  }
  showAnalysisWizardStep(2);
});
document.getElementById("analysisPreviousButton").addEventListener("click", () => showAnalysisWizardStep(1));
document.querySelectorAll("[data-analysis-metric], #analysisWindowMode, #analysisTimeBudget").forEach((input) => {
  input.addEventListener("change", () => {
    analysisSettingsPreferencesDirty = true;
  });
});
document.getElementById("analysisToggleAllTests").addEventListener("click", (event) => {
  const checkboxes = [...document.querySelectorAll("[data-analysis-test]")];
  const selectAll = checkboxes.some((checkbox) => !checkbox.checked);
  checkboxes.forEach((checkbox) => {
    checkbox.checked = selectAll;
  });
  event.currentTarget.textContent = selectAll ? "\u53D6\u6D88\u5168\u9009" : "\u5168\u9009";
});
document.getElementById("analysisOptionsForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (analysisWizardStep === 1) {
    if (document.querySelector("[data-analysis-metric]:checked")) showAnalysisWizardStep(2);
    else writeTerminal("$ \u8BF7\u81F3\u5C11\u9009\u62E9\u4E00\u4E2A\u8BA1\u7B97\u6307\u6807", true);
    return;
  }
  if (analysisWizardStep !== 2) return;
  document.getElementById("startGroupAnalysisButton").disabled = true;
  showTestGroupAnalysis().catch((error) => {
    activeGroupAnalysisJobId = "";
    document.getElementById("startGroupAnalysisButton").disabled = false;
    document.getElementById("analysisOptionsCancel").disabled = false;
    document.getElementById("analysisOptionsClose").disabled = false;
    document.getElementById("analysisOptionsCancel").textContent = "\u5173\u95ED";
    document.getElementById("analysisDialogProgress").innerHTML = `<section class="group-analysis-warning"><strong>\u7ED3\u679C\u5206\u6790\u5931\u8D25</strong><br>${escapeHtml3(error.message || "\u672A\u77E5\u9519\u8BEF")}</section>`;
    if (analysisWizardStep !== 3) {
      document.getElementById("analysisOptionsCancel").textContent = "\u53D6\u6D88";
    } else {
      visualizationWorkspace.showGroupAnalysis(`<section class="group-analysis-warning"><strong>\u7ED3\u679C\u5206\u6790\u5931\u8D25</strong><br>${escapeHtml3(error.message || "\u672A\u77E5\u9519\u8BEF")}</section>`);
    }
    writeTerminal(`$ \u6D4B\u8BD5\u7EC4\u7ED3\u679C\u5206\u6790\u5931\u8D25
  ${error.message || "\u672A\u77E5\u9519\u8BEF"}`, true);
  });
});
document.getElementById("logButton").addEventListener("click", (event) => {
  if (event.currentTarget.getAttribute("aria-disabled") === "true") event.preventDefault();
});
document.getElementById("ganttButton").addEventListener("click", (event) => {
  if (event.currentTarget.getAttribute("aria-disabled") === "true") event.preventDefault();
});
document.getElementById("batchLogButton").addEventListener("click", (event) => {
  if (event.currentTarget.getAttribute("aria-disabled") === "true") event.preventDefault();
});
document.getElementById("batchGanttButton").addEventListener("click", (event) => {
  if (event.currentTarget.getAttribute("aria-disabled") === "true") event.preventDefault();
});
document.getElementById("closeDrawer").addEventListener("click", closeStepDrawer);
document.getElementById("drawerLayer").addEventListener("click", (event) => {
  if (event.target.id === "drawerLayer") closeStepDrawer();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeStepDrawer();
});
document.addEventListener("keydown", (event) => {
  const card = event.target.closest?.("[data-step-card]");
  if (card && event.key === "Enter") openPJobStepDrawer(Number(card.dataset.routeIndex), Number(card.dataset.stageIndex));
});
document.addEventListener("input", (event) => {
  if (event.target.matches("[data-device-timing-target], [data-device-execution-target]")) updateDeviceTimingFromControl(event.target);
  const execution = state.deviceTimingDraft?.execution;
  if (execution && event.target.id === "executionFluctuationRatio") {
    execution.fluctuation.ratio = Math.max(0, Math.min(1, (Number(event.target.value) || 0) / 100));
    markDeviceTimingDirty();
  }
  if (execution && event.target.id === "executionMinimumOffset") {
    execution.fluctuation.minimumOffsetSeconds = Number(event.target.value);
    markDeviceTimingDirty();
  }
  if (execution && event.target.id === "executionMaximumOffset") {
    execution.fluctuation.maximumOffsetSeconds = Number(event.target.value);
    markDeviceTimingDirty();
  }
  if (event.target.matches("[data-scope], [data-option], [data-time-index], [data-round-time-index]")) updateStateFromControl(event.target);
});
document.addEventListener("change", (event) => {
  const execution = state.deviceTimingDraft?.execution;
  if (execution && event.target.name === "executionTimingMode") {
    execution.mode = event.target.value === "fluctuation" ? "fluctuation" : "fixed";
    markDeviceTimingDirty();
    renderDeviceTimingConfiguration();
    return;
  }
  if (execution && event.target.id === "executionFluctuationKind") {
    execution.fluctuation.kind = event.target.value === "offset" ? "offset" : "ratio";
    markDeviceTimingDirty();
    renderDeviceTimingConfiguration();
    return;
  }
  const transferAxis = event.target.closest?.("[data-robot-transfer-axis]");
  if (transferAxis) {
    state.deviceRobotTransferAxes[transferAxis.dataset.robotTransferAxis] = transferAxis.value;
    renderDeviceRobotTiming();
    return;
  }
  const transferStation = event.target.closest?.("[data-robot-transfer-station]");
  if (transferStation) {
    const robotName = transferStation.dataset.robotTransferStation;
    const selectedAxis = state.deviceRobotTransferAxes[robotName] === "dest" ? "dest" : "src";
    state.deviceRobotTransferSources[`${robotName}:${selectedAxis}`] = transferStation.value;
    renderDeviceRobotTiming();
    return;
  }
  if (event.target.matches("[data-scope], [data-option], [data-time-index], [data-round-time-index]")) {
    updateStateFromControl(event.target);
    if (event.target.dataset.scope === "stage-candidate-toggle") {
      refreshCandidatePicker(event.target);
      return;
    }
    if (["name", "cleanType", "recipeTime", "wacRecipeTime", "jobType", "waferCount", "bufferOption", ...ROUTE_CLEAN_KEYS].includes(event.target.dataset.key) || event.target.dataset.timeIndex !== void 0 || event.target.dataset.roundTimeIndex !== void 0 || ["stage-candidates", "cjob", "pjob"].includes(event.target.dataset.scope)) renderAll();
    else if (state.drawer) {
      renderRoutes();
      renderStepDrawer();
    } else if (["test-step", "test-route"].includes(event.target.dataset.scope)) renderRounds();
  }
  if (event.target.name === "strategy") {
    state.strategy = event.target.value;
    const algorithm = state.availableAlgorithms.find((item) => item.strategy === state.strategy);
    if (algorithm?.defaultOptions && typeof algorithm.defaultOptions === "object") {
      Object.assign(state.options, algorithm.defaultOptions);
    }
    retainSessionSchedulingConfiguration();
    document.getElementById("roundCount").disabled = false;
    updateStrategyOptionVisibility();
    showAlgorithmDetails(state.strategy);
    markTestDirty();
    renderAll();
  }
});
document.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab-target]");
  if (tab) switchTab(tab.dataset.tabTarget);
  const transferFillButton = event.target.closest("[data-robot-transfer-fill]");
  if (transferFillButton) {
    fillRobotTransferTimes(transferFillButton);
    return;
  }
  const deviceConfigSection = event.target.closest("[data-device-config-section]");
  if (deviceConfigSection) {
    switchDeviceConfigSection(deviceConfigSection.dataset.deviceConfigSection);
    return;
  }
  const robotSlotChoice = event.target.closest("[data-robot-slot-name][data-robot-arm-count]");
  if (robotSlotChoice && !robotSlotChoice.disabled) {
    setRobotArmCount(robotSlotChoice.dataset.robotSlotName, Number(robotSlotChoice.dataset.robotArmCount)).catch((error) => writeTerminal(`$ \u673A\u5668\u624B\u69FD\u4F4D\u4FDD\u5B58\u5931\u8D25
  ${error.message}`, true));
    return;
  }
  const robotSlotDefault = event.target.closest("[data-robot-slot-default]");
  if (robotSlotDefault && !robotSlotDefault.disabled) {
    restoreRobotSlotDefault(robotSlotDefault.dataset.robotSlotDefault).catch((error) => writeTerminal(`$ \u673A\u5668\u624B\u9ED8\u8BA4\u914D\u7F6E\u6062\u590D\u5931\u8D25
  ${error.message}`, true));
    return;
  }
  const batchErrorButton = event.target.closest("[data-batch-error]");
  if (batchErrorButton) {
    openBatchErrorDialog(Number(batchErrorButton.dataset.batchError));
    return;
  }
  const batchResultCard = event.target.closest("[data-batch-item-index]");
  if (batchResultCard && !event.target.closest(".batch-result-meta")) selectBatchItem(Number(batchResultCard.dataset.batchItemIndex));
  const playbackResult = event.target.closest("[data-playback-result]");
  if (playbackResult) {
    visualizationWorkspace.loadResult(playbackResult.dataset.playbackResult, playbackResult.dataset.playbackName).then(() => visualizationWorkspace.showPlayback()).catch((error) => writeTerminal(`$ \u62D3\u6251\u56DE\u653E\u52A0\u8F7D\u5931\u8D25
  ${error.message || "\u672A\u77E5\u9519\u8BEF"}`, true));
    return;
  }
  const workspaceResult = event.target.closest("[data-workspace-result]");
  if (workspaceResult) {
    visualizationWorkspace.loadResult(workspaceResult.dataset.workspaceResult, workspaceResult.dataset.workspaceName).then(() => visualizationWorkspace.show()).catch((error) => writeTerminal(`$ \u5DE5\u4F5C\u53F0\u52A0\u8F7D\u5931\u8D25
  ${error.message || "\u672A\u77E5\u9519\u8BEF"}`, true));
    return;
  }
  const button = event.target.closest("[data-action]");
  if (button && !button.disabled) {
    handleAction(button);
    return;
  }
  const card = event.target.closest("[data-step-card]");
  if (card) openPJobStepDrawer(Number(card.dataset.routeIndex), Number(card.dataset.stageIndex));
});
window.addEventListener("pagehide", () => {
  if (runSettingsPreferencesDirty) {
    fetch("/api/preferences/run-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runSettings: currentRunSettingsPreferences() }),
      keepalive: true
    }).catch(() => {
    });
  }
  if (analysisSettingsPreferencesDirty) {
    fetch("/api/preferences/analysis-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ analysisSettings: currentAnalysisSettingsPreferences() }),
      keepalive: true
    }).catch(() => {
    });
  }
  if (state.deviceTimingDirty && state.workspaceDeviceId && state.deviceTimingDraft) {
    fetch(`/api/workspaces/${state.workspaceDeviceId}/device-timing`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timing: state.deviceTimingDraft }),
      keepalive: true
    }).catch(() => {
    });
  }
  if (state.dirty && state.workspaceDeviceId && state.testCaseId) {
    fetch(`/api/workspaces/${state.workspaceDeviceId}/tests/${state.testCaseId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentTestSnapshot()),
      keepalive: true
    }).catch(() => {
    });
  }
});
initializeCompactSelects();
renderAll();
renderWorkspaceControls();
renderDeviceTimingConfiguration();
checkService();
loadRunSettingsPreferences().catch((error) => writeTerminal(`$ \u8FD0\u884C\u8BBE\u7F6E\u8BFB\u53D6\u5931\u8D25
  ${error.message || "\u672A\u77E5\u9519\u8BEF"}`, true));
loadAnalysisSettingsPreferences().catch((error) => writeTerminal(`$ \u5206\u6790\u8BBE\u7F6E\u8BFB\u53D6\u5931\u8D25
  ${error.message || "\u672A\u77E5\u9519\u8BEF"}`, true));
loadWorkspaceCatalog().catch((error) => setWorkspaceStatus(`\u6D4B\u8BD5\u96C6\u8BFB\u53D6\u5931\u8D25\uFF1A${error.message}`, "dirty"));
