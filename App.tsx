import React from 'react';
import PokerHUD from './components/PokerHUD';

const App: React.FC = () => {
  return (
    <div className="min-h-screen bg-black text-white font-sans overflow-hidden">
      <PokerHUD />
    </div>
  );
};

export default App;