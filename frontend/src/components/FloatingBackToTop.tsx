import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowUp } from 'lucide-react';

export const FloatingBackToTop: React.FC = () => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      const top = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
      setVisible(top > 160);
    };

    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.button
          type="button"
          onClick={scrollToTop}
          initial={{ opacity: 0, scale: 0.85, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.85, y: 12 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          title="回到顶部"
          aria-label="回到顶部"
          className="fixed bottom-24 right-4 sm:bottom-8 sm:right-8 z-50 w-10 h-10 rounded-capsule frost border border-wb-border-strong shadow-card flex items-center justify-center text-wb-text-secondary hover:text-wb-text-primary hover:border-wb-text-primary active:scale-95 transition-all duration-200 group"
        >
          <ArrowUp className="w-4 h-4 transition-transform group-hover:-translate-y-0.5" />
        </motion.button>
      )}
    </AnimatePresence>
  );
};
