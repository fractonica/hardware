// Dashboard entry (spec 08 §8.9, design c6 §5): starts the live connection, then renders the routes.

import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { router } from './app.tsx';
import { queryClient, startLive } from './runtime.ts';

import './styles.css';

void startLive();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
