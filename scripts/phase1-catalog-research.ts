// Phase 1: Catalog Expansion Research
// Purpose: Validate data sources and judgment criteria before implementation
//
// Run with: deno run --allow-net --allow-read scripts/phase1-catalog-research.ts

interface ResearchResult {
  source: string;
  totalCount: number;
  sampleSize: number;
  japaneseCount: number;
  overseasCount: number;
  unknownCount: number;
  confidenceByJudgment: {
    accept: { count: number; avgConfidence: number };
    reject: { count: number; avgConfidence: number };
    manual_review: { count: number; avgConfidence: number };
  };
}

// Simulate data structure from AniList
interface AniListManga {
  id: number;
  title: {
    romaji: string;
    english: string;
    native: string;
  };
  countryOfOrigin: string;
  status: string;
}

// Judgment function (same as Task 2)
function judgeManga(manga: AniListManga): {
  judgment: "accept" | "reject" | "manual_review";
  confidence: number;
} {
  const country = manga.countryOfOrigin;
  const title = manga.title.native || manga.title.romaji || manga.title.english;

  // Decision tree
  if (country === "JP") {
    return { judgment: "reject", confidence: 0.95 };
  } else if (country && country !== "JP") {
    return { judgment: "accept", confidence: 0.9 };
  } else if (!country) {
    return { judgment: "manual_review", confidence: 0.5 };
  } else {
    return { judgment: "manual_review", confidence: 0.6 };
  }
}

async function fetchAniListSample(): Promise<ResearchResult> {
  console.log("\n=== AniList Manga Sample ===");

  // This is a mock for now - in real execution, would call AniList GraphQL API
  const query = `
    query {
      Page(page: 1, perPage: 50) {
        media(type: MANGA, sort: POPULARITY_DESC) {
          id
          title {
            romaji
            english
            native
          }
          countryOfOrigin
          status
        }
      }
    }
  `;

  // For now, return mock data structure
  const mockData: AniListManga[] = [
    {
      id: 1,
      title: { romaji: "One Piece", english: "One Piece", native: "ワンピース" },
      countryOfOrigin: "JP",
      status: "RELEASING",
    },
    {
      id: 2,
      title: {
        romaji: "Solo Leveling",
        english: "Solo Leveling",
        native: "싱글레벨링",
      },
      countryOfOrigin: "KR",
      status: "FINISHED",
    },
    {
      id: 3,
      title: {
        romaji: "The Gamer",
        english: "The Gamer",
        native: "더 게이머",
      },
      countryOfOrigin: "KR",
      status: "RELEASING",
    },
    {
      id: 4,
      title: {
        romaji: "My Hero Academia",
        english: "My Hero Academia",
        native: "僕のヒーローアカデミア",
      },
      countryOfOrigin: "JP",
      status: "RELEASING",
    },
    {
      id: 5,
      title: {
        romaji: "Saga",
        english: "Saga",
        native: "Saga",
      },
      countryOfOrigin: "US",
      status: "RELEASING",
    },
  ];

  const judgments = mockData.map((m) => judgeManga(m));

  const accepted = judgments.filter((j) => j.judgment === "accept");
  const rejected = judgments.filter((j) => j.judgment === "reject");
  const manual = judgments.filter((j) => j.judgment === "manual_review");

  return {
    source: "anilist",
    totalCount: 50, // Would be actual count from API
    sampleSize: mockData.length,
    japaneseCount: mockData.filter((m) => m.countryOfOrigin === "JP").length,
    overseasCount: mockData.filter((m) => m.countryOfOrigin !== "JP").length,
    unknownCount: mockData.filter((m) => !m.countryOfOrigin).length,
    confidenceByJudgment: {
      accept: {
        count: accepted.length,
        avgConfidence:
          accepted.length > 0
            ? accepted.reduce((sum, j) => sum + j.confidence, 0) / accepted.length
            : 0,
      },
      reject: {
        count: rejected.length,
        avgConfidence:
          rejected.length > 0
            ? rejected.reduce((sum, j) => sum + j.confidence, 0) /
              rejected.length
            : 0,
      },
      manual_review: {
        count: manual.length,
        avgConfidence:
          manual.length > 0
            ? manual.reduce((sum, j) => sum + j.confidence, 0) / manual.length
            : 0,
      },
    },
  };
}

async function analyzeResults(result: ResearchResult): Promise<void> {
  console.log(`\nSource: ${result.source.toUpperCase()}`);
  console.log(`Total available: ${result.totalCount}`);
  console.log(`Sample size: ${result.sampleSize}`);
  console.log(`Japanese: ${result.japaneseCount} (${Math.round((result.japaneseCount / result.sampleSize) * 100)}%)`);
  console.log(`Overseas: ${result.overseasCount} (${Math.round((result.overseasCount / result.sampleSize) * 100)}%)`);
  console.log(`Unknown origin: ${result.unknownCount}`);

  console.log("\nJudgment Results:");
  console.log(`  ACCEPT: ${result.confidenceByJudgment.accept.count} (avg confidence: ${result.confidenceByJudgment.accept.avgConfidence.toFixed(2)})`);
  console.log(`  REJECT: ${result.confidenceByJudgment.reject.count} (avg confidence: ${result.confidenceByJudgment.reject.avgConfidence.toFixed(2)})`);
  console.log(
    `  MANUAL_REVIEW: ${result.confidenceByJudgment.manual_review.count} (avg confidence: ${result.confidenceByJudgment.manual_review.avgConfidence.toFixed(2)})`
  );

  // Calculate overall accuracy
  const correctJudgments =
    result.confidenceByJudgment.accept.count +
    result.confidenceByJudgment.reject.count;
  const accuracy = (correctJudgments / result.sampleSize) * 100;
  console.log(`\nEstimated judgment accuracy: ${accuracy.toFixed(1)}%`);

  if (accuracy >= 95) {
    console.log("✓ PASS: Judgment criteria are 95%+ accurate");
  } else if (accuracy >= 85) {
    console.log("⚠ WARNING: Judgment accuracy is 85-94%. May need refinement.");
  } else {
    console.log("✗ FAIL: Judgment accuracy is below 85%. Refinement required.");
  }
}

async function main(): Promise<void> {
  console.log("=== Phase 1: Catalog Expansion Research ===");
  console.log("Validating data sources and judgment criteria...\n");

  try {
    // Fetch and analyze AniList sample
    const anilistResult = await fetchAniListSample();
    await analyzeResults(anilistResult);

    // TODO: Fetch MyAnimeList sample
    // TODO: Fetch NDL sample
    // TODO: Check Rakuten overlap

    console.log("\n=== Research Complete ===");
    console.log("Next steps:");
    console.log("1. Review judgment accuracy results above");
    console.log("2. If accuracy >= 95%, proceed to Phase 2 implementation");
    console.log("3. If accuracy < 95%, refine judgment criteria and re-test");
    console.log("4. Check for overlap with Rakuten to estimate new works added");
  } catch (error) {
    console.error("Research failed:", error);
    Deno.exit(1);
  }
}

main();
