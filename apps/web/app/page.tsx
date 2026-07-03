export default function Home() {
  return (
    <main className="min-h-screen bg-stone-50 text-stone-950">
      <div className="mx-auto flex min-h-screen w-full max-w-4xl flex-col px-6 py-8 sm:px-10 sm:py-10">
        <section className="flex flex-1 items-center">
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-xs font-medium uppercase tracking-tight text-stone-500">
              rightmodeler
            </p>
            <h1 className="mt-6 text-3xl font-semibold tracking-tight sm:text-5xl">
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
