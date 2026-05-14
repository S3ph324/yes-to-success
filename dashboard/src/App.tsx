import { Routes, Route, Navigate } from "react-router-dom";
import { Sidebar } from "./components/Sidebar";
import { Generate } from "./pages/Generate";
import { Gallery } from "./pages/Gallery";
import { BrandKit } from "./pages/BrandKit";
import { Briefs } from "./pages/Briefs";
import { Characters } from "./pages/Characters";
import { Queue } from "./pages/Queue";
import { Posting } from "./pages/Posting";

const App = () => {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto p-8">
        <Routes>
          <Route path="/" element={<Navigate to="/generate" replace />} />
          <Route path="/generate" element={<Generate />} />
          <Route path="/gallery" element={<Gallery />} />
          <Route path="/brand" element={<BrandKit />} />
          <Route path="/briefs" element={<Briefs />} />
          <Route path="/characters" element={<Characters />} />
          <Route path="/queue" element={<Queue />} />
          <Route path="/posting" element={<Posting />} />
        </Routes>
      </main>
    </div>
  );
};

export default App;
