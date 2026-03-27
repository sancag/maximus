"use client";

import { LayoutShell } from "@/components/shell/layout-shell";
import { useWebSocket } from "@/hooks/use-websocket";

function getWsUrl(): string {
	if (typeof window === "undefined") return "";
	const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
	return `${proto}//${window.location.host}/ws`;
}

export default function Home() {
	useWebSocket(getWsUrl());
	return <LayoutShell />;
}
