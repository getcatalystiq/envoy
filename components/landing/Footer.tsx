'use client';
import Link from 'next/link';
import { Github } from 'lucide-react';

export function Footer() {
  return (
    <footer className="bg-gray-900 text-gray-400">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-12">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-4">
            <Link href="/" className="flex items-center gap-2">
              <img src="/logo.png" alt="Envoy" className="w-8 h-8 rounded-lg" />
              <span className="font-semibold text-lg text-white">Envoy</span>
            </Link>
            <span className="text-sm hidden sm:inline">AI-powered drip emails</span>
          </div>

          <div className="flex items-center gap-6">
            <a href="#features" className="text-sm hover:text-white transition-colors">Features</a>
            <a href="#how-it-works" className="text-sm hover:text-white transition-colors">How It Works</a>
            <a
              href="https://github.com/getcatalystiq/envoy"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-white transition-colors"
            >
              <Github className="w-5 h-5" />
            </a>
          </div>
        </div>

      </div>
    </footer>
  );
}
