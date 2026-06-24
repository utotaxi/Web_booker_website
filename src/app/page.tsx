import WebBooker from "@/components/WebBooker";

export default function Home() {
  return (
    <div className="min-h-screen bg-page">
      <header className="border-b border-gray-300 bg-white py-6 shadow-sm">
        <div className="mx-auto max-w-3xl px-5 text-center">
          <h1 className="text-2xl font-bold text-navy sm:text-3xl">
            Book Your Journey
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            Get an instant quote for scheduled rides
          </p>
        </div>
      </header>
      <main>
        <WebBooker />
      </main>
    </div>
  );
}
