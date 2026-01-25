import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/ThemeProvider";
import ErrorBoundary from "@/components/ErrorBoundary";
import Editor from "@/pages/Editor";
import Login from "@/pages/Login";
import NotFound from "@/pages/not-found";

function AuthenticatedRouter() {
  const { data: authStatus, isLoading } = useQuery<{ authenticated: boolean }>({
    queryKey: ["/api/auth/status"],
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!authStatus?.authenticated) {
    return <Login />;
  }

  return (
    <Switch>
      <Route path="/" component={Editor} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <Toaster />
          <ErrorBoundary>
            <AuthenticatedRouter />
          </ErrorBoundary>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
