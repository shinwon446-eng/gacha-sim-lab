// 실물 상품 데이터셋 무결성 테스트
//   npm test
import test from "node:test";
import { formatRate } from "../lib/products";
import assert from "node:assert/strict";

test("published probability labels retain every configured decimal place", () => {
  for (const value of [49, 1.2345, 0.0147, 0.0001]) assert.equal(Number.parseFloat(formatRate(value)), value);
});
import { readFileSync } from "node:fs";
import {
  BOXES,
  BOX_BY_SLUG,
  CATEGORY_FILTERS,
  REFUND_RATE,
  byCategory,
  cashReturn,
  ceilingValue,
  dropTable,
  expectedValue,
  getBoxBySlug,
  heroBox,
  isValueGuaranteed,
  floorCash,
  floorRatio,
  dollarRow,
  techRow,
  luxuryRow,
  jackpotRow,
  retailReturn,
  sortBoxes,
  trending,
  RETAIL_RTP_MIN,
  RETAIL_RTP_MAX,
  FLOOR_CASH_MIN,
  FLOOR_CASH_MAX, sellValueOf } from "../lib/products";
import { formatCurrency } from "../lib/formatCurrency";

test("박스 12종 이상, slug 고유", () => {
  assert.ok(BOXES.length >= 12, `박스 ${BOXES.length}종`);
  const slugs = BOXES.map((b) => b.slug);
  assert.equal(new Set(slugs).size, slugs.length, "slug 중복");
  assert.equal(Object.keys(BOX_BY_SLUG).length, BOXES.length);
});

test("박스마다 항목 7종 이상, item id 는 박스 안에서 고유 (기프트카드·캐시백은 박스 간 공유)", () => {
  for (const b of BOXES) {
    assert.ok(b.items.length >= 7, `${b.slug}: 항목 ${b.items.length}종`);
    const ids = b.items.map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length, `${b.slug}: item id 중복`);
  }
});

test("하이브리드 리워드: 바닥은 USDT 캐시백(100% 적립), 조잡한 저가 실물 꽝 없음, 중위권에 디지털 자산", () => {
  const junk = /스티커|케이블 타이|키캡|필름|스탠드|NATO|파우치|워치 롤|다이캐스트|모델카|굿즈/;
  for (const b of BOXES) {
    const floor = b.items.reduce((m, i) => (i.value < m.value ? i : m), b.items[0]);
    assert.equal(floor.kind, "cash", `${b.slug}: 바닥 ${floor.id}`);
    assert.equal(sellValueOf(floor), floor.value, `${b.slug}: 캐시백은 100%`);
    for (const i of b.items) assert.ok(!junk.test(i.name), `${b.slug}: 저가 실물 꽝 ${i.name}`);
    for (const i of b.items.filter((x) => x.kind !== "cash")) assert.equal(sellValueOf(i), +(i.value * REFUND_RATE).toFixed(2), i.id);
  }
  const digital = new Set(BOXES.flatMap((b) => b.items.filter((i) => i.kind === "digital").map((i) => i.id)));
  for (const id of ["gc-apple100", "gc-apple500", "gc-amazon100", "gc-steam50"]) assert.ok(digital.has(id), id);
  const drops = new Set(BOXES.flatMap((b) => b.items.filter((i) => i.kind === "cash" && i.value >= 50).map((i) => i.id)));
  for (const id of ["usdt-50", "usdt-100"]) assert.ok(drops.has(id), id);
});

test("드롭 확률 합계는 박스마다 정확히 100", () => {
  for (const b of BOXES) {
    const sum = b.items.reduce((s, i) => s + i.dropRate, 0);
    assert.equal(sum, 100, `${b.slug}: 합 ${sum}`);
    assert.ok(b.items.every((i) => i.dropRate > 0), `${b.slug}: 0 이하 확률 존재`);
  }
});

test("금액은 USDT 소수 둘째 자리까지 — 통화 기호는 데이터에 없다", () => {
  const cents = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9;
  for (const b of BOXES) {
    assert.ok(cents(b.price), `${b.slug}: price ${b.price}`);
    for (const i of b.items) assert.ok(cents(i.value), `${i.id}: value ${i.value}`);
  }
});

test("가격 스펙트럼: 1 USDT 박스 3종 이상, 100 USDT 잭팟 2종 이상, 전부 스펙 가격표 안", () => {
  const allowed = new Set([1, 3, 5, 20, 25, 30, 50, 100]);
  for (const b of BOXES) assert.ok(allowed.has(b.price), `${b.slug}: ${b.price}`);
  assert.ok(BOXES.filter((b) => b.price === 1).length >= 3);
  assert.ok(BOXES.filter((b) => b.price === 100).length >= 2);
});

test("잭팟 배수: 1달러 박스 1,000배 이상, 럭셔리·잭팟 1,300배 이상 항목 존재", () => {
  const top = (b: (typeof BOXES)[number]) => ceilingValue(b) / b.price;
  assert.ok(dollarRow().some((b) => top(b) >= 1000), "1달러 1,000배 없음");
  assert.ok(jackpotRow().every((b) => top(b) >= 1300), "잭팟 1,300배 미만");
  assert.ok(luxuryRow().some((b) => top(b) >= 2000), "럭셔리 2,000배 없음");
});

test("12개 박스의 슬롯 파동과 현금 하우스 엣지는 백만 슬롯 기준으로 검증된다", () => {
  for (const box of BOXES) {
    const at = (multiple: number) => box.items.filter(i => i.value === +(box.price * multiple).toFixed(2));
    for (const multiple of [0.5, 0.8, 0.99, 2, 5, 15]) {
      assert.ok(at(multiple).length > 0, `${box.slug}: ${multiple}x 티어 누락`);
    }
    const waveAt = (multiple: number, role: "cashback" | "gift" | "drop") =>
      at(multiple).find(i => i.id.startsWith(`wave-${role}-`))!;
    const half = waveAt(0.5, "cashback");
    const buffer = waveAt(0.8, "cashback");
    const near = waveAt(0.99, "cashback");
    const two = waveAt(2, "gift");
    const five = waveAt(5, "drop");
    const mid = waveAt(15, "gift");
    assert.equal(half.dropRate, 50, box.slug);
    assert.equal(buffer.dropRate, 22, box.slug);
    assert.equal(near.dropRate, 17, box.slug);
    assert.ok(half.dropRate > buffer.dropRate && buffer.dropRate > near.dropRate &&
      near.dropRate > two.dropRate && two.dropRate > five.dropRate &&
      five.dropRate > mid.dropRate, `${box.slug}: 파동 확률 단조 감소`);
    assert.ok(box.items.filter(i => !i.id.startsWith("wave-")).every(i => mid.dropRate > i.dropRate), `${box.slug}: 프리미엄 확률`);
    const recovery = box.items.filter(i => i.value >= box.price * 2 && i.value <= box.price * 5);
    assert.ok(recovery.reduce((sum, i) => sum + i.dropRate, 0) >= 10, `${box.slug}: 복구 구간`);
    assert.equal(Math.round((two.dropRate + five.dropRate) * 10_000), 105_000, `${box.slug}: 복구 슬롯`);
    const premium = box.items.filter(i => !i.id.startsWith("wave-"));
    assert.equal(premium.length, 6, `${box.slug}: 프리미엄 상품 수`);
    assert.equal(Math.round(mid.dropRate * 10_000) + premium.length, 5_000, `${box.slug}: 중박·프리미엄 슬롯`);
    const atLeast15 = box.items.filter(i => i.value >= box.price * 15)
      .reduce((sum, i) => sum + Math.round(i.dropRate * 10_000), 0);
    assert.ok(atLeast15 >= 4_994 && atLeast15 <= 5_000, `${box.slug}: 정가 15배 이상 슬롯 ${atLeast15}`);
    const hitSlots = box.items.filter(i => i.value >= box.price * 0.99)
      .reduce((sum, i) => sum + Math.round(i.dropRate * 10_000), 0);
    assert.equal(hitSlots, 280_000, `${box.slug}: 적중 슬롯 ${hitSlots}`);
    assert.ok(Math.abs(cashReturn(box) - 0.95) <= 0.0005, `${box.slug}: cash RTP ${cashReturn(box)}`);
    assert.ok(retailReturn(box) >= RETAIL_RTP_MIN && retailReturn(box) < RETAIL_RTP_MAX, `${box.slug}: retail RTP ${retailReturn(box)}`);
  }
});

test("최저 구성을 즉시 환급해도 원금을 넘지 못한다", () => {
  for (const b of BOXES) {
    assert.ok(
      floorCash(b) < b.price,
      `${b.slug}: 최저 보장 회수액 ${floorCash(b)} >= 가격 ${b.price}`,
    );
  }
});

test("probabilities remain representable as one-million exact outcome slots", () => {
  for (const box of BOXES) {
    const units = box.items.map(i => Math.round(i.dropRate * 10_000));
    assert.equal(units.reduce((a,b)=>a+b,0),1_000_000);
    assert.ok(units.every(n=>n>0));
    assert.ok(Number.isFinite(retailReturn(box)));
  }
});

test("바닥 보장: 최저 구성 즉시 캐시백은 가격의 50%", () => {
  for (const b of BOXES) {
    const r = floorRatio(b);
    assert.ok(r >= FLOOR_CASH_MIN && r <= FLOOR_CASH_MAX, `${b.slug}: 바닥 ${(r * 100).toFixed(1)}%`);
    assert.equal(floorCash(b), +b.guaranteedMin.toFixed(2)); // 바닥은 USDT 캐시백 — 100% 적립
    assert.ok(isValueGuaranteed(b), b.slug);
  }
  for (const b of BOXES.filter((x) => x.price === 1)) assert.equal(floorCash(b), 0.5, b.slug);
  for (const b of BOXES.filter((x) => x.price === 100)) assert.equal(floorCash(b), 50, b.slug);
});

test("guaranteedMin 은 항목 최저가에서 파생된다", () => {
  for (const b of BOXES) {
    assert.equal(b.guaranteedMin, Math.min(...b.items.map((i) => i.value)), b.slug);
    assert.equal(ceilingValue(b), Math.max(...b.items.map((i) => i.value)), b.slug);
  }
});

test("4개 행 셀렉터가 전부 채워지고 카테고리 규칙을 지킨다", () => {
  assert.ok(trending().length >= 5);
  assert.deepEqual(
    trending(5)
      .slice(0, 5)
      .map((b) => b.trendingRank),
    [1, 2, 3, 4, 5],
    "TRENDING 앞머리가 순위대로 오지 않음",
  );
  for (const [row, cat] of [[dollarRow, "dollar"], [techRow, "tech"], [luxuryRow, "luxury"], [jackpotRow, "jackpot"]] as const) {
    assert.ok(row().length >= 2, cat);
    for (const b of row()) assert.equal(b.category, cat, b.slug);
  }
});

test("히어로 박스는 1 USDT 박스다", () => {
  assert.equal(heroBox().price, 1);
  assert.ok(heroBox().tagline.length > 10, "히어로 카피 누락");
});

test("카테고리는 필터 목록 안의 값만 쓰고, 필터마다 결과가 있다", () => {
  const keys = CATEGORY_FILTERS.filter((f) => f.key !== "all").map((f) => f.key);
  const allowed = new Set(keys);
  for (const b of BOXES) assert.ok(allowed.has(b.category), `${b.slug}: ${b.category}`);
  for (const k of keys) assert.ok(byCategory(k).length > 0, `빈 카테고리: ${k}`);
  assert.equal(byCategory("all").length, BOXES.length);
});

test("이미지 경로는 데이터가 아니라 productImages 가 쥔다", () => {
  for (const b of BOXES) {
    assert.ok("image" in b && "src" in b.image, b.slug);
    for (const i of b.items) assert.ok("image" in i && "src" in i.image, i.id);
  }
  // 데이터셋 어디에도 URL 문자열이 박혀 있으면 안 된다
  const flat = JSON.stringify(BOXES.map((b) => ({ t: b.tone, g: b.tagline, i: b.items.map((x) => x.code) })));
  assert.ok(!/https?:\/\//.test(flat), "데이터셋에 URL 이 직접 박혀 있다");
});

test("정렬 키가 원본을 변형하지 않고 올바르게 동작한다", () => {
  const before = BOXES.map((b) => b.slug);
  const asc = sortBoxes(BOXES, "price-asc").map((b) => b.price);
  const desc = sortBoxes(BOXES, "price-desc").map((b) => b.price);
  assert.deepEqual(asc, [...asc].sort((a, b) => a - b));
  assert.deepEqual(desc, [...desc].sort((a, b) => b - a));
  assert.deepEqual(BOXES.map((b) => b.slug), before, "원본 배열이 변형됨");
  assert.equal(getBoxBySlug("jackpot-cybertruck")?.titleEn, "tesla cybertruck edition");
  assert.equal(getBoxBySlug("no-such-box"), undefined);
});

test("dropTable 은 실판매가 내림차순이며 원본을 변형하지 않는다", () => {
  for (const b of BOXES) {
    const order = dropTable(b).map((i) => i.value);
    assert.deepEqual(order, [...order].sort((x, y) => y - x), b.slug);
    assert.equal(b.items.length, order.length);
  }
});

test("박스 가격은 세 통화 어느 쪽으로도 혼용 없이 렌더된다", () => {
  for (const b of BOXES) {
    assert.match(formatCurrency(b.price, "USDT"), /^[\d,]+\u00A0USDT$/, b.slug);
    assert.match(formatCurrency(b.price, "USD"), /^\$[\d,]+$/, b.slug);
    assert.match(formatCurrency(b.price, "KRW"), /^₩[\d,]+$/, b.slug);
  }
});

test("카피와 데이터에 이모지가 없다", () => {
  const emoji = new RegExp("[\\uD83C-\\uDBFF][\\uDC00-\\uDFFF]|[\\u2600-\\u27BF\\u2B00-\\u2BFF\\uFE0F]");
  const strings: string[] = [];
  for (const b of BOXES) {
    strings.push(b.title, b.titleEn, b.badge, b.slug, b.code, b.tagline);
    for (const i of b.items) strings.push(i.name, i.nameEn, i.code);
  }
  for (const f of CATEGORY_FILTERS) strings.push(f.label);
  for (const s of strings) assert.ok(!emoji.test(s), `이모지 포함: ${s}`);
});

test("컬렉션 이미지는 유효한 로컬 WebP이며 출처와 imageUrl 별칭을 보존한다", () => {
  let have = 0;
  for (const b of BOXES) {
    assert.equal(b.imageUrl, b.image.src, b.slug);
    for (const x of [b, ...b.items]) {
      assert.equal(x.imageUrl, x.image.src, x.id);
      if (x.image.src) {
        have += 1;
        assert.match(
          x.image.src,
          /^\/(?:voila-test-shinwon\/)?assets\/photography\/photo-[\w-]+\.webp$/,
          `${x.id}: 검증된 로컬 이미지 경로 필요`,
        );
        const assetPath = x.image.src.slice(x.image.src.indexOf("/assets/"));
        const image = readFileSync(new URL(`../public${assetPath}`, import.meta.url));
        assert.ok(image.length > 1000, `${x.id}: 빈 이미지`);
        assert.equal(image.toString("ascii", 0, 4), "RIFF", `${x.id}: 잘못된 WebP 헤더`);
        assert.equal(image.toString("ascii", 8, 12), "WEBP", `${x.id}: 잘못된 WebP 형식`);
        assert.ok(x.image.credit && x.image.credit.length > 8, `${x.id}: 출처 누락`);
        assert.match(x.image.credit!, /Unsplash License/, `${x.id}: 라이선스 표기 누락`);
      }
    }
  }
  assert.ok(have >= 60, `확보 이미지 ${have}장`);
  // 모든 박스 커버는 이미지가 있어야 한다
  for (const b of BOXES) assert.ok(b.image.src, `${b.slug}: 커버 이미지 없음`);
  // 히어로와 TRENDING 상위는 반드시 이미지가 있어야 한다
  assert.ok(heroBox().image.src, "히어로 이미지 누락");
  for (const b of trending(5)) assert.ok(b.image.src, `${b.slug}: TRENDING 이미지 누락`);
});
