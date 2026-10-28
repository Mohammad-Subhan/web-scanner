"use client";

import dynamic from "next/dynamic";

// Camera, OpenCV and jscanify are browser-only, so the scanner never renders on the server.
const Scanner = dynamic(() => import("@/components/Scanner"), {
  ssr: false,
  loading: () => <p className="p-4">Loading scanner…</p>,
});

export default function Page() {
  return <Scanner />;
}
