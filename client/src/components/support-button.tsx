import { HelpCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

export function SupportButton() {
  const [isOpen, setIsOpen] = useState(false);

  const { data: supportSetting } = useQuery<{ key: string, value: string }>({
    queryKey: ["/api/settings/SUPPORT_CONTACT"],
  });

  return (
    <>
      <Button
        variant="outline"
        className="w-full justify-start gap-3 rounded-2xl border-white/10 bg-white/5 hover:bg-white/10 text-white"
        onClick={() => setIsOpen(true)}
        data-testid="button-support-open"
      >
        <HelpCircle className="w-4 h-4" />
        <span>Support</span>
      </Button>

      {isOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setIsOpen(false)} />
          <div className="relative bg-white text-black rounded-2xl p-6 max-w-sm w-full mx-4 shadow-2xl">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-black">☎️ Support</h2>
              <button onClick={() => setIsOpen(false)} className="text-gray-500 hover:text-black">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3 text-black">
              <div className="text-center text-gray-400 font-black tracking-widest text-sm">
                ➖➖➖➖➖➖➖➖➖➖
              </div>

              <div className="text-center text-sm font-black space-y-2">
                <div>Contact for assistance</div>
                <div className="text-blue-600">{supportSetting?.value || "@support_user"}</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
