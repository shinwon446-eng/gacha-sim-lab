import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { CurrencyHydrator } from "@/components/layout/CurrencyHydrator";

/**
 * 타이포그래피 (CLAUDE.md §2)
 *   전 사이트 단일 서체, Pretendard Variable (한글, 라틴, 숫자 한 벌).
 *   제목, 본문, 숫자 모두 같은 가족을 쓰고 굵기(600~900)로만 위계를 만든다. 세리프(Cinzel)는 쓰지 않는다.
 *   가변 폰트 CSS 를 <head> 에서 preload + 동기 로드하고, globals.css 가 * 선택자로 폰트를 고정해
 *   정적 렌더링 직후에도 글꼴이 바뀌며 깜빡이지 않는다.
 */
const pretendard = localFont({ src: "../public/assets/fonts/PretendardVariable.woff2", variable: "--font-ui", display: "swap", weight: "45 920" });

const SITE = "https://shinwon446-eng.github.io/gacha-sim-lab";
const TITLE = "VOILA";
const DESCRIPTION = "롤렉스부터 하이엔드 테크까지, 1달러에 여는 럭셔리 언박싱. 정품 무료 배송 또는 95% 즉시 페이백.";
const OG_IMAGE = `${SITE}/assets/photography/photo-1610375461246-83df859d849d.webp`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "VOILA",
    title: TITLE,
    description: DESCRIPTION,
    url: SITE,
    images: [{ url: OG_IMAGE, width: 1200, height: 800, alt: "VOILA luxury collection" }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: [OG_IMAGE],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className={pretendard.variable}>
      <body className="min-h-screen bg-canvas font-sans text-white antialiased">
        <CurrencyHydrator />
        {children}
      </body>
    </html>
  );
}
