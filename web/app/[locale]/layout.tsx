import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { routing, type Locale } from "@/i18n/routing";
import { LocaleHtmlLang } from "@/components/layout/LocaleHtmlLang";
import { Footer } from "@/components/layout/Footer";
import { AuthHost } from "@/components/auth/AuthHost";
import { MotionPreferences } from "@/components/layout/MotionPreferences";
import { LabBadge } from "@/components/layout/LabBadge";
import { LAB_TITLE } from "@/lib/labSite";

/** 정적 export, 세 로케일을 전부 미리 생성한다. 목록 밖 로케일은 404. */
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}
export const dynamicParams = false;

const SITE = "https://shinwon446-eng.github.io/gacha-sim-lab";
const TITLE = LAB_TITLE;
const OG_IMAGE = `${SITE}/assets/photography/photo-1610375461246-83df859d849d.webp`;
/** 로케일별 메타 설명, /en/, /zh/ 에 한국어가 새지 않게 여기서 분기한다 */
const DESCRIPTION: Record<Locale, string> = {
  ko: "롤렉스부터 하이엔드 테크까지, 1달러에 여는 럭셔리 언박싱. 정품 무료 배송 또는 95% 즉시 페이백.",
  en: "From Rolex to high-end tech, luxury unboxing from $1. Free authentic shipping or 95% instant payback.",
  zh: "从劳力士到高端科技，1美元开启奢华开箱。正品免费配送或 95% 即时返现。",
};
const OG_LOCALE: Record<Locale, string> = { ko: "ko_KR", en: "en_US", zh: "zh_CN" };

export function generateMetadata({ params: { locale } }: { params: { locale: string } }): Metadata {
  const loc = ((routing.locales as readonly string[]).includes(locale) ? locale : routing.defaultLocale) as Locale;
  const description = DESCRIPTION[loc];
  return {
    metadataBase: new URL(SITE),
    title: TITLE,
    description,
    robots: { index: false, follow: false },
    alternates: {
      canonical: `${SITE}/${loc}/`,
      languages: Object.fromEntries(routing.locales.map((l) => [l, `${SITE}/${l}/`])),
    },
    openGraph: {
      type: "website",
      siteName: "VOILA",
      title: TITLE,
      description,
      url: `${SITE}/${loc}/`,
      locale: OG_LOCALE[loc],
      alternateLocale: routing.locales.filter((l) => l !== loc).map((l) => OG_LOCALE[l as Locale]),
      images: [{ url: OG_IMAGE, width: 1200, height: 800, alt: "VOILA luxury collection" }],
    },
    twitter: { card: "summary_large_image", title: TITLE, description, images: [OG_IMAGE] },
  };
}

export default async function LocaleLayout({
  children,
  params: { locale },
}: {
  children: React.ReactNode;
  params: { locale: string };
}) {
  if (!(routing.locales as readonly string[]).includes(locale)) notFound();
  setRequestLocale(locale);
  const messages = await getMessages();

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <MotionPreferences>
      <LocaleHtmlLang locale={locale as Locale} />
      <div>
        {children}
        <Footer />
      </div>
      {/* 로그인, 회원가입 모달과 확인 토스트, 어느 페이지에서든 열린다 */}
      <AuthHost />
      <LabBadge />
      </MotionPreferences>
    </NextIntlClientProvider>
  );
}
