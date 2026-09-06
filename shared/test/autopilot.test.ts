/**
 * オートパイロットの純関数（SPEC §9.2 / §9.4 / §7.7）。
 * 採点・順位・型の選択・日割りは、同じ入力から常に同じ結果が出る（AI を使わない）。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOOK_ORDER,
  MIN_SAMPLES_LEARNING,
  SCORE_WEIGHTS,
  mondayIndex,
  percentile,
  pickHook,
  postsForDay,
  scorePost,
  scoreWeightsOf,
  toLearningAggregate,
} from "../src/autopilot";

describe("percentile（SPEC §9.2）", () => {
  const dist = [10, 20, 30, 40, 50];

  it("分布の中の順位を 0..1 で返す", () => {
    expect(percentile(dist, 5)).toBe(0);
    expect(percentile(dist, 10)).toBe(0.2);
    expect(percentile(dist, 30)).toBe(0.6);
    expect(percentile(dist, 50)).toBe(1);
    expect(percentile(dist, 999)).toBe(1);
  });

  it("同じ値が並んでいても、その値以下の個数で数える", () => {
    expect(percentile([1, 1, 1, 5], 1)).toBe(0.75);
  });

  it("空の分布は 0", () => {
    expect(percentile([], 100)).toBe(0);
  });
});

describe("scorePost（SPEC §9.2）", () => {
  const viewsDist = [100, 200, 300, 400, 500];
  const likeRateDist = [0.01, 0.02, 0.03, 0.04, 0.05];

  it("null の項は分子からも分母からも外す", () => {
    // carry も ctr も無い（コメント無し・リンク無し）ので views .5 と likes .2 だけ
    const got = scorePost({
      views: 300,
      likes: 9, // 0.03 → pl = 0.6
      firstChildViews: null,
      clicks: null,
      viewsDist,
      likeRateDist,
      weights: SCORE_WEIGHTS.balanced,
    });
    expect(got.pv).toBe(0.6);
    expect(got.pl).toBe(0.6);
    expect(got.carry).toBeNull();
    expect(got.ctr).toBeNull();
    expect(got.score).toBeCloseTo((0.5 * 0.6 + 0.2 * 0.6) / 0.7, 6);
  });

  it("carry は children[0].views / views、ctr は clicks / views", () => {
    const got = scorePost({
      views: 400,
      likes: 8,
      firstChildViews: 200,
      clicks: 40,
      viewsDist,
      likeRateDist,
      weights: SCORE_WEIGHTS.balanced,
    });
    expect(got.carry).toBeCloseTo(0.5, 6);
    expect(got.ctr).toBeCloseTo(0.1, 6);
  });

  it("carry と ctr は 1 を超えない", () => {
    const got = scorePost({
      views: 100,
      likes: 1,
      firstChildViews: 500,
      clicks: 900,
      viewsDist,
      likeRateDist,
      weights: SCORE_WEIGHTS.balanced,
    });
    expect(got.carry).toBe(1);
    expect(got.ctr).toBe(1);
  });

  it("views=0 なら likes の順位は出さない（V=0 は除外）", () => {
    const got = scorePost({
      views: 0,
      likes: 5,
      firstChildViews: 10,
      clicks: 3,
      viewsDist,
      likeRateDist,
      weights: SCORE_WEIGHTS.balanced,
    });
    expect(got.pl).toBeNull();
    expect(got.carry).toBeNull();
    expect(got.ctr).toBeNull();
  });

  it("weights='followers' は ctr の重みが 0 なので、リンクがあっても score に効かない", () => {
    const base = {
      views: 300,
      likes: 9,
      firstChildViews: 150,
      viewsDist,
      likeRateDist,
      weights: SCORE_WEIGHTS.followers,
    };
    const withLink = scorePost({ ...base, clicks: 300 });
    const without = scorePost({ ...base, clicks: null });
    expect(withLink.score).toBeCloseTo(without.score, 10);
  });

  it("score は 0..1 に収まる", () => {
    for (const name of ["balanced", "followers", "clicks"] as const) {
      const got = scorePost({
        views: 500,
        likes: 25,
        firstChildViews: 500,
        clicks: 500,
        viewsDist,
        likeRateDist,
        weights: SCORE_WEIGHTS[name],
      });
      expect(got.score).toBeGreaterThanOrEqual(0);
      expect(got.score).toBeLessThanOrEqual(1);
    }
  });

  it("weights の名前が不明でも balanced に倒す", () => {
    expect(scoreWeightsOf("なにこれ")).toEqual(SCORE_WEIGHTS.balanced);
    expect(scoreWeightsOf(null)).toEqual(SCORE_WEIGHTS.balanced);
    expect(scoreWeightsOf("clicks")).toEqual(SCORE_WEIGHTS.clicks);
  });
});

describe("pickHook（SPEC §9.4-3）", () => {
  it("n>=10 の型を平均 score の高い順に選ぶ", () => {
    const got = pickHook({
      history: [
        { value: "警告型", n: 12, avgScore: 0.4 },
        { value: "数字型", n: 20, avgScore: 0.8 },
      ],
    });
    expect(got.hook).toBe("数字型");
    expect(got.proven).toBe(true);
    expect(got.n).toBe(20);
  });

  it("直近3本と同じ型は避ける（ローテーション）", () => {
    const got = pickHook({
      history: [
        { value: "数字型", n: 20, avgScore: 0.8 },
        { value: "警告型", n: 12, avgScore: 0.4 },
      ],
      recentHooks: ["数字型", "疑問型", "断定型"],
    });
    expect(got.hook).toBe("警告型");
  });

  it("実績ありが全部直近3本に入っていたら、1位に戻る", () => {
    const got = pickHook({
      history: [{ value: "数字型", n: 20, avgScore: 0.8 }],
      recentHooks: ["数字型"],
    });
    expect(got.hook).toBe("数字型");
  });

  it("n<10 の型は実績として数えない", () => {
    const got = pickHook({
      history: [{ value: "数字型", n: MIN_SAMPLES_LEARNING - 1, avgScore: 0.9 }],
    });
    expect(got.proven).toBe(false);
    expect(got.hook).toBe(DEFAULT_HOOK_ORDER[0]);
  });

  it("実績が無ければ既定順を、直近3本を飛ばしながら回す", () => {
    expect(pickHook({}).hook).toBe("呼びかけ型");
    expect(pickHook({ recentHooks: ["呼びかけ型"] }).hook).toBe("警告型");
    expect(pickHook({ recentHooks: ["警告型", "呼びかけ型"] }).hook).toBe("意外性型");
  });

  it("hook_mode='fixed' なら fixed_hook に固定する", () => {
    const got = pickHook({
      mode: "fixed",
      fixedHook: "体験談型",
      history: [{ value: "数字型", n: 50, avgScore: 0.9 }],
      recentHooks: ["体験談型", "体験談型", "体験談型"],
    });
    expect(got.hook).toBe("体験談型");
  });

  it("同じ入力からは常に同じ型が出る（決定的）", () => {
    const input = {
      history: [
        { value: "警告型", n: 12, avgScore: 0.5 },
        { value: "数字型", n: 12, avgScore: 0.5 }, // 同点
      ],
    };
    expect(pickHook(input).hook).toBe(pickHook(input).hook);
  });
});

describe("postsForDay（SPEC §9.4-2）", () => {
  it("週7本は毎日1本", () => {
    for (let d = 0; d < 7; d++) expect(postsForDay(7, d)).toBe(1);
  });

  it("週14本は毎日2本", () => {
    for (let d = 0; d < 7; d++) expect(postsForDay(14, d)).toBe(2);
  });

  it("週3本は余りを週の前半（月火水）に寄せる", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((d) => postsForDay(3, d))).toEqual([1, 1, 1, 0, 0, 0, 0]);
  });

  it("週5本は月〜金", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((d) => postsForDay(5, d))).toEqual([1, 1, 1, 1, 1, 0, 0]);
  });

  it("週10本は毎日1本＋月〜水がもう1本", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((d) => postsForDay(10, d))).toEqual([2, 2, 2, 1, 1, 1, 1]);
  });

  it("合計は必ず perWeek と一致する", () => {
    for (const per of [1, 3, 5, 7, 9, 14, 21]) {
      const sum = [0, 1, 2, 3, 4, 5, 6].reduce((a, d) => a + postsForDay(per, d), 0);
      expect(sum).toBe(per);
    }
  });

  it("mondayIndex は Date.getUTCDay()（日曜=0）を月曜=0 に直す", () => {
    expect(mondayIndex(1)).toBe(0); // 月
    expect(mondayIndex(0)).toBe(6); // 日
    expect(mondayIndex(6)).toBe(5); // 土
  });
});

describe("toLearningAggregate（SPEC §7.7 / §12.3）", () => {
  const raw = { dim: "hook", value: "警告型", scoreSum: 6, viewsSum: 12000, likeRateSum: 0.24 };

  it("n>=10 なら平均を出す", () => {
    const got = toLearningAggregate({ ...raw, n: 10 });
    expect(got.avgScore).toBeCloseTo(0.6, 6);
    expect(got.avgViews).toBe(1200);
    expect(got.likeRate).toBeCloseTo(0.024, 6);
  });

  it("n<10 なら3つとも null（画面は「集計中」を出す）", () => {
    const got = toLearningAggregate({ ...raw, n: 9 });
    expect(got.n).toBe(9);
    expect(got.avgScore).toBeNull();
    expect(got.avgViews).toBeNull();
    expect(got.likeRate).toBeNull();
  });

  it("likeRate は「いいね合計 ÷ 表示回数合計」ではない（SPEC §7.7）", () => {
    // 投稿ごとの like_rate を足したものを n で割る。表示の多い1本に引っ張られない
    const got = toLearningAggregate({
      dim: "hook",
      value: "数字型",
      n: 10,
      scoreSum: 5,
      viewsSum: 100_000, // 1本だけ極端に伸びた
      likeRateSum: 0.1, // 各投稿は 1% 前後
    });
    expect(got.likeRate).toBeCloseTo(0.01, 6);
    expect(got.likeRate).not.toBeCloseTo(0.1 / 100_000, 6);
  });
});
