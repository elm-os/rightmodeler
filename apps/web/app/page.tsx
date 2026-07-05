import { Nav } from "./components/sections/Nav";
import { Hero } from "./components/sections/Hero";
import { Footer } from "./components/sections/Footer";

// Single-page: slim sticky nav over the hero (with its illustration), inside the
// max-width column with left/right hairline rules, closed by a matching slim footer.
export default function Home() {
  return (
    <>
      <span id="top" aria-hidden className="sr-only" />
      <Nav />
      <main className="flex flex-1 flex-col">
        <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col border-x border-ash-border">
          <Hero />
        </div>
      </main>
      <Footer />
    </>
  );
}
