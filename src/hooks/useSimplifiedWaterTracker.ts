
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { WaterLogEntry } from "@/types/water.types";

export const useSimplifiedWaterTracker = () => {
  const { user, waterGoal } = useAuth();
  const [loading, setLoading] = useState(true);
  const [currentAmount, setCurrentAmount] = useState(0);
  const [streak, setStreak] = useState(0);
  const [completedDays, setCompletedDays] = useState(0);
  const [history, setHistory] = useState<WaterLogEntry[]>([]);
  const today = new Date().toISOString().split('T')[0];

  // Fetch water data and achievements
  const fetchData = useCallback(async () => {
    if (!user) return;
    
    setLoading(true);
    try {
      // Get today's water intake
      const { data: todayData } = await supabase
        .from('water_intake')
        .select('intake_amount')
        .eq('user_id', user.id)
        .eq('intake_date', today)
        .maybeSingle();

      setCurrentAmount(todayData?.intake_amount || 0);
      
      // Get water history
      const { data: historyData, error: historyError } = await supabase
        .from('water_intake')
        .select('*')
        .eq('user_id', user.id)
        .order('intake_date', { ascending: false });

      if (historyError) throw historyError;
      
      // Format history data
      const formattedHistory = historyData.map(entry => ({
        id: entry.id,
        date: entry.intake_date,
        amount: entry.intake_amount,
        goal: waterGoal,
        completed: entry.intake_amount >= waterGoal
      }));
      
      setHistory(formattedHistory);

      // Get achievements data
      const { data: achievementData } = await supabase
        .from('achievements')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1);

      if (achievementData && achievementData.length > 0) {
        setStreak(achievementData[0].streak_days || 0);
        
        // Count completed days
        const { count: completedCount } = await supabase
          .from('water_intake')
          .select('intake_date', { count: 'exact', head: false })
          .eq('user_id', user.id)
          .gte('intake_amount', waterGoal);
        
        setCompletedDays(completedCount || 0);
      }
    } catch (error) {
      console.error('Error fetching water data:', error);
      toast.error('Failed to load your water data');
    } finally {
      setLoading(false);
    }
  }, [user, today, waterGoal]);

  // Setup subscription to water_intake changes
  useEffect(() => {
    if (!user) return;
    
    fetchData();

    // Real-time subscription
    const channel = supabase
      .channel('water-tracker-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'water_intake',
          filter: `user_id=eq.${user.id}`
        },
        () => {
          fetchData();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, fetchData]);

  // Add water function with simplified achievement tracking
  const addWater = async (amount: number) => {
    if (!user) return;
    
    try {
      const newAmount = currentAmount + amount;
      const wasGoalCompleted = currentAmount >= waterGoal;
      const isGoalNowCompleted = newAmount >= waterGoal;
      
      // Update or insert water intake record
      const { data: existingEntry } = await supabase
        .from('water_intake')
        .select('id')
        .eq('user_id', user.id)
        .eq('intake_date', today)
        .maybeSingle();
      
      if (existingEntry) {
        await supabase
          .from('water_intake')
          .update({ intake_amount: newAmount })
          .eq('id', existingEntry.id);
      } else {
        await supabase
          .from('water_intake')
          .insert([{
            user_id: user.id,
            intake_date: today,
            intake_amount: newAmount
          }]);
      }
      
      // Update achievement if goal is now completed
      if (!wasGoalCompleted && isGoalNowCompleted) {
        // Get yesterday's record to check streak
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];
        
        const { data: yesterdayData } = await supabase
          .from('water_intake')
          .select('intake_amount')
          .eq('user_id', user.id)
          .eq('intake_date', yesterdayStr)
          .maybeSingle();
        
        // Calculate new streak
        let newStreak = streak;
        if (yesterdayData && yesterdayData.intake_amount >= waterGoal) {
          // Yesterday was completed, increment streak
          newStreak = streak + 1;
        } else {
          // Yesterday was not completed, reset streak to 1
          newStreak = 1;
        }
        
        // Update achievements table
        await supabase
          .from('achievements')
          .upsert({
            user_id: user.id,
            streak_days: newStreak,
            achievement_date: today
          });
        
        // Generate personalized message
        try {
          const { data } = await supabase.functions.invoke('generate-personalized-message', {
            body: { 
              userName: user.user_metadata?.name || 'Hydration Hero',
              milestoneType: '100%'
            }
          });
          
          if (data?.personalizedMessage) {
            toast.success(data.personalizedMessage);
          } else {
            toast.success('Congratulations! You reached your daily water goal! 💧');
          }
        } catch (error) {
          console.error('Error generating message:', error);
          toast.success('Goal completed! Great job staying hydrated!');
        }
      } else {
        toast.success(`Added ${amount}ml of water`);
      }
      
      // Refresh data
      await fetchData();
    } catch (error) {
      console.error('Error adding water:', error);
      toast.error('Failed to add water');
    }
  };

  // Simplified milestone check
  useEffect(() => {
    if (!user || loading) return;
    
    const percentage = waterGoal > 0 ? Math.min(100, (currentAmount / waterGoal) * 100) : 0;
    
    // Check for specific milestones (25%, 50%, 75%)
    const milestones = [
      { threshold: 25, message: "You've reached 25% of your daily goal!" },
      { threshold: 50, message: "Halfway there! 50% of your goal complete." },
      { threshold: 75, message: "Almost there! 75% of your goal complete." }
    ];
    
    for (const milestone of milestones) {
      if (percentage >= milestone.threshold && percentage < milestone.threshold + 25) {
        const key = `milestone-${milestone.threshold}-${today}`;
        if (!localStorage.getItem(key)) {
          localStorage.setItem(key, 'true');
          toast.info(milestone.message);
        }
      }
    }
  }, [currentAmount, waterGoal, user, loading, today]);
  
  return {
    loading,
    currentAmount,
    dailyGoal: waterGoal,
    streak,
    completedDays,
    history,
    addWater,
  };
};
