import React, { useState, useEffect } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { apiClient } from '../api/client';

export const SiteBanner: React.FC = () => {
  const [announcement, setAnnouncement] = useState<string | null>(null);

  useEffect(() => {
    apiClient.get('/admin/announcement/current').then((res) => {
      if (res.data && res.data.content) {
        const dismissed = sessionStorage.getItem(`banner_${res.data.id}`);
        if (!dismissed) {
          setAnnouncement(res.data.content);
        }
      }
    }).catch(() => {});
  }, []);

  if (!announcement) return null;

  return (
    <div className="bg-wb-bg-elevated border-b border-wb-border-strong text-wb-text-primary px-4 py-2 text-xs md:text-sm flex items-center justify-between shadow-sm">
      <div className="flex items-center gap-2 max-w-4xl mx-auto flex-1">
        <AlertCircle className="w-4 h-4 flex-shrink-0" />
        <span className="font-medium truncate">{announcement}</span>
      </div>
      <button
        onClick={() => setAnnouncement(null)}
        className="p-1 hover:opacity-70 rounded-capsule"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};
