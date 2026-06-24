"use client";

import { useEffect, useRef, useState } from "react";
import { LocationPinIcon } from "@/components/icons";

interface Suggestion {
  placeId: string;
  description: string;
  mainText: string;
  secondaryText: string;
}

interface LocationAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  id?: string;
}

function makeSessionToken(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

export default function LocationAutocomplete({
  value,
  onChange,
  placeholder,
  id,
}: LocationAutocompleteProps) {
  const [query, setQuery] = useState(value);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);

  const sessionTokenRef = useRef(makeSessionToken());
  const containerRef = useRef<HTMLDivElement>(null);
  const skipNextFetch = useRef(false);

  useEffect(() => {
    setQuery(value);
  }, [value]);

  useEffect(() => {
    if (skipNextFetch.current) {
      skipNextFetch.current = false;
      return;
    }

    const q = query.trim();
    if (q.length < 2) {
      setSuggestions([]);
      setOpen(false);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    const handle = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/places/autocomplete?input=${encodeURIComponent(
            q
          )}&sessionToken=${sessionTokenRef.current}`,
          { signal: controller.signal }
        );
        const data = await res.json();

        if (!res.ok) {
          setError(data.error || "Address search failed.");
          setSuggestions([]);
        } else {
          setSuggestions(data.suggestions || []);
        }
        setOpen(true);
        setActiveIndex(-1);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setError("Address search failed. Please try again.");
        }
      } finally {
        setLoading(false);
      }
    }, 250);

    return () => {
      controller.abort();
      clearTimeout(handle);
    };
  }, [query]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const select = (s: Suggestion) => {
    skipNextFetch.current = true;
    setQuery(s.description);
    onChange(s.description);
    setSuggestions([]);
    setOpen(false);
    setActiveIndex(-1);
    sessionTokenRef.current = makeSessionToken();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      if (activeIndex >= 0 && activeIndex < suggestions.length) {
        e.preventDefault();
        select(suggestions[activeIndex]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} className="relative w-full">
      <input
        id={id}
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          onChange(e.target.value);
        }}
        onFocus={() => {
          if (suggestions.length > 0) setOpen(true);
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-listbox`}
        className="w-full px-4 py-3 text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none"
      />

      {loading && (
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">
          …
        </span>
      )}

      {open && (suggestions.length > 0 || error) && (
        <ul
          id={`${id}-listbox`}
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-auto rounded-lg border border-gray-200 bg-white py-1 shadow-xl"
        >
          {error && (
            <li className="px-4 py-3 text-sm text-red-600">{error}</li>
          )}
          {suggestions.map((s, idx) => (
            <li key={s.placeId || idx} role="option" aria-selected={idx === activeIndex}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => select(s)}
                className={`flex w-full items-start gap-2.5 px-4 py-2.5 text-left text-sm transition ${
                  idx === activeIndex ? "bg-gray-100" : "hover:bg-gray-50"
                }`}
              >
                <span className="mt-0.5 shrink-0 text-navy">
                  <LocationPinIcon className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-gray-800">
                    {s.mainText}
                  </span>
                  {s.secondaryText && (
                    <span className="block truncate text-xs text-gray-500">
                      {s.secondaryText}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
