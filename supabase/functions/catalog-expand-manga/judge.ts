export interface MangaData {
  title: string;
  countryOfOrigin?: string;
  language?: string;
}

export function judgeManga(manga: MangaData): {
  judgment: "accept" | "reject" | "manual_review";
  reason: string;
  confidence: number;
} {
  const country = manga.countryOfOrigin;
  const language = manga.language;

  if (country === "JP") {
    return {
      judgment: "reject",
      reason: "Japanese origin",
      confidence: 0.95,
    };
  }
  if (country && country !== "JP") {
    return {
      judgment: "accept",
      reason: "Overseas origin",
      confidence: 0.9,
    };
  }
  if (!country) {
    return {
      judgment: "manual_review",
      reason: "Missing country data",
      confidence: 0.4,
    };
  }

  return {
    judgment: "manual_review",
    reason: "Uncertain origin",
    confidence: 0.6,
  };
}

export function judgeBook(book: MangaData): {
  judgment: "accept" | "reject" | "manual_review";
  reason: string;
  confidence: number;
} {
  const country = book.countryOfOrigin;
  const language = book.language;

  if (country === "JP") {
    return {
      judgment: "reject",
      reason: "Japanese origin",
      confidence: 0.95,
    };
  }
  if (language && language !== "ja" && language !== "Japanese") {
    return {
      judgment: "accept",
      reason: "Non-Japanese language",
      confidence: 0.85,
    };
  }
  if (!country && !language) {
    return {
      judgment: "manual_review",
      reason: "Missing country and language",
      confidence: 0.3,
    };
  }

  return {
    judgment: "manual_review",
    reason: "Uncertain origin",
    confidence: 0.6,
  };
}
