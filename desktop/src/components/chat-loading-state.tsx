import { Skeleton } from "./ui/skeleton";

// #preview ChatLoadingState {}
export function ChatLoadingState() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 p-6">
      <div className="flex flex-1 flex-col justify-end gap-4">
        <Skeleton className="h-14 w-[42%] rounded-2xl" />
        <Skeleton className="h-20 w-[58%] self-end rounded-2xl" />
        <Skeleton className="h-12 w-[34%] rounded-2xl" />
      </div>
      <Skeleton className="h-14 w-full rounded-2xl" />
    </div>
  );
}
