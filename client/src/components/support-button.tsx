import { MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function SupportButton() {
  const openChatbot = () => {
    // Find and click the chatbot launcher button injected by the widget script
    const chatbotBtn =
      (document.querySelector("[data-chatbot-id]") as HTMLElement) ||
      (document.querySelector(".chatbot-launcher") as HTMLElement) ||
      (document.querySelector("button[class*='chatbot']") as HTMLElement);

    if (chatbotBtn) {
      chatbotBtn.click();
    } else {
      // Fallback: dispatch a custom event the widget may listen to
      window.dispatchEvent(new CustomEvent("open-chatbot"));
    }
  };

  return (
    <Button
      variant="outline"
      className="w-full justify-start gap-3 rounded-2xl border-white/10 bg-white/5 hover:bg-white/10 text-white"
      onClick={openChatbot}
      data-testid="button-support-open"
    >
      <MessageCircle className="w-4 h-4" />
      <span>AI Support</span>
    </Button>
  );
}
