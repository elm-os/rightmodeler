function GitHubIcon({
  size = 18,
  ...props
}: React.SVGProps<SVGSVGElement> & {
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.801 8.207 11.387.6.111.793-.261.793-.577v-2.234C5.662 21.302 4.967 19.16 4.967 19.16c-.546-1.387-1.333-1.756-1.333-1.756-1.09-.744.083-.729.083-.729 1.205.084 1.84 1.237 1.84 1.237 1.07 1.834 2.807 1.304 3.492.998.107-.775.418-1.305.761-1.605-2.665-.304-5.467-1.334-5.467-5.93 0-1.311.47-2.382 1.237-3.222-.124-.303-.536-1.523.117-3.176 0 0 1.008-.322 3.301 1.23A11.51 11.51 0 0 1 12 5.8c1.02.005 2.047.138 3.006.404 2.29-1.552 3.297-1.23 3.297-1.23.653 1.653.241 2.873.118 3.176.768.84 1.235 1.911 1.235 3.222 0 4.608-2.807 5.624-5.48 5.92.431.373.824 1.103.824 2.223v3.293c0 .319.192.688.8.577C20.566 21.8 24 17.302 24 12 24 5.373 18.627 0 12 0Z" />
    </svg>
  );
}

export default function Home() {
  return (
    <main className="min-h-screen bg-stone-50 text-stone-950">
      <div className="mx-auto flex min-h-screen w-full max-w-4xl flex-col px-6 py-8 sm:px-10 sm:py-10">
        <header className="flex items-center justify-between">
          <p className="text-sm font-medium tracking-tighter text-stone-500 sm:text-base">
            rightmodeler
          </p>
          <span className="text-stone-400">
            <GitHubIcon className="h-[18px] w-[18px]" />
          </span>
        </header>

        <section className="flex flex-1 items-center">
          <div className="mx-auto max-w-2xl text-center">
            <h1 className="text-3xl font-semibold tracking-tight sm:text-5xl">
              Find where cheaper models can replace expensive ones without
              breaking quality.
            </h1>
          </div>
        </section>

        <footer className="flex flex-col items-center gap-3 border-t border-stone-200 pt-5 text-center text-sm text-stone-500 sm:flex-row sm:justify-between sm:text-left">
          <p>Cheaper-model recommendations from your own historical runs.</p>
          <div className="flex items-center gap-4">
            <a
              className="transition-colors hover:text-stone-950"
              href="https://github.com/elm-os/rightmodeler"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
          </div>
        </footer>
      </div>
    </main>
  );
}
