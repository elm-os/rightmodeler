// Case-study registry: the card-level facts each surface needs (landing band, /case-study index,
// metadata, JSON-LD). The full article bodies live in their route files under app/case-study/;
// this file only carries what is shared, so the two never drift. Every figure here is quoted
// verbatim from the customer engagement write-ups.

export type CaseStudy = {
  slug: string;
  company: string;
  website: string;
  /** Article h1, also the OG/JSON-LD headline. */
  title: string;
  /** Card headline: the anchor number first. */
  headline: string;
  /** Card supporting line. */
  excerpt: string;
  /** Mono footer line on the card. */
  tagline: string;
  /** Meta description, shared with llms.txt. */
  description: string;
  date: string;
  readingMinutes: number;
  logo: { src: string; alt: string; width: number; height: number };
  hero: { src: string; alt: string };
  /** Leadership quote for the landing testimonial band and the article close. The identity
      fields feed the schema.org Person on the case-study Article (researched, verified links
      only; a wrong sameAs is worse than none). */
  testimonial: {
    quote: string;
    name: string;
    role: string;
    avatar: { src: string };
    jobTitle: string;
    sameAs: string[];
    org: { name: string; url: string; sameAs: string[] };
  };
};

export const BSIDE: CaseStudy = {
  slug: "bside",
  company: "B:Side Assist",
  website: "https://www.bsideassist.com",
  title: "From brute-force reasoning to precision routing",
  headline: "70.8% lower inference cost. Quality held at a measured 100%.",
  excerpt:
    "AI Assist's 11 AI layers moved from all Terra · xhigh to a per-workload routing policy: 53.3% faster, 114.3% more throughput, zero points of quality lost.",
  tagline: "financial intelligence · 11 workloads",
  description:
    "How rightmodeler right-sized AI Assist's 11 AI layers with a per-workload routing policy: 70.8% lower projected inference cost, 53.3% faster responses, 114.3% higher throughput, and a measured 100% quality pass rate.",
  date: "2026-07-22",
  readingMinutes: 4,
  logo: {
    src: "/case-study/bside-logo.png",
    alt: "B:Side Assist logo",
    width: 915,
    height: 415,
  },
  hero: {
    src: "/case-study/bside-hero.jpg",
    alt: "Watercolor illustration of one heavy stroke splitting into several right-sized channels, one carrying a violet to orange gradient",
  },
  testimonial: {
    quote:
      "rightmodeler took AI Assist from brute force to precision routing. Costs fell 70.8%, responses got twice as fast, and quality held at 100%, measured, not assumed.",
    name: "Chris Myers",
    role: "CEO, B:Side Capital and Fund",
    avatar: { src: "/case-study/chris-myers.jpg" },
    jobTitle: "Chief Executive Officer",
    sameAs: [
      "https://www.linkedin.com/in/cmyers85/",
      "https://www.bsidecapital.org/chris-myers",
      "https://substack.com/@thebsideway",
    ],
    org: {
      name: "B:Side Capital and Fund",
      url: "https://www.bsidecapital.org",
      sameAs: ["https://www.linkedin.com/company/bsidecapital"],
    },
  },
};

export const IAM360: CaseStudy = {
  slug: "iam360",
  company: "iAM360",
  website: "https://www.iam360.ai",
  title:
    "How iAM360 made its AI coach dramatically more efficient without lowering the quality bar",
  headline:
    "56-57% lower cost per request. The hardest work got a better model.",
  excerpt:
    "The AI coach now routes every job to the right level of intelligence: Sol for complex coaching, Terra for moderate analysis, small validated models for routine work.",
  tagline: "fitness + wellness · ai coach",
  description:
    "How iAM360 used rightmodeler's routing and evidence framework to cut modeled AI cost per request by 56-57%, while upgrading its hardest coaching paths from Terra to Sol.",
  date: "2026-07-22",
  readingMinutes: 5,
  logo: {
    src: "/case-study/iam360-logo.png",
    alt: "iAM360 logo",
    width: 256,
    height: 170,
  },
  hero: {
    src: "/case-study/iam360-hero.jpg",
    alt: "Watercolor illustration of a calm pulse line with a single peak carrying a violet to orange gradient",
  },
  testimonial: {
    quote:
      "rightmodeler concentrated intelligence where our members feel it. The hardest coaching moved up to Sol, routine work got faster, and cost per request dropped by more than half.",
    name: "Brian Douglas",
    role: "Founder, iAM360",
    avatar: { src: "/case-study/brian-douglas.jpg" },
    jobTitle: "Founder, Executive Health and Performance Coach",
    sameAs: ["https://www.iam360.ai/about"],
    org: {
      name: "iAM360",
      url: "https://www.iam360.ai",
      sameAs: [
        "https://www.linkedin.com/company/iam360-evolved/",
        "https://www.instagram.com/iam360_evolved/",
        "https://x.com/iAM360_Evolved",
        "https://www.youtube.com/@iAM360-Official",
        "https://www.tiktok.com/@iam360_performance_coach",
      ],
    },
  },
};

export const CASE_STUDIES: CaseStudy[] = [BSIDE, IAM360];
